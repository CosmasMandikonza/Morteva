/**
 * OFFLINE FIXTURE runner — implements the same AgentCliRunner interface as
 * NpxAgentCliRunner by replaying scripted official-CLI outputs. The fixture
 * is structurally barred from being mistaken for a live run: journeys built
 * on it report environment 'sponsor-testnet' ONLY when the caller passes the
 * real config, and every fixture scenario is labeled in its rawOutput.
 */
import type { AgentCliRunner, AgentPaymentResult, AgentVerifyResult } from './agent-cli.js';
import { classify } from './agent-cli.js';

export type FixturePayScript = ReadonlyArray<{
  readonly url: string;
  readonly outcome:
    | { readonly kind: 'paid'; readonly nonce: string; readonly txHash: string }
    | { readonly kind: 'refused'; readonly reason: string; readonly atSettlement?: boolean }
    | { readonly kind: 'in-doubt'; readonly reason: string; readonly txHash: string }
    | { readonly kind: 'pending'; readonly nonce: string }
    | { readonly kind: 'held'; readonly nonce: string }
    | { readonly kind: 'cli-failure'; readonly message: string };
}>;

export interface FixtureState {
  /** Payment identities the fixture has already settled (already-paid semantics). */
  readonly settledIdentities: ReadonlySet<string>;
  /** Payment identities the mandate account has refused (re-sent allowed with new values). */
  readonly refusedIdentities: ReadonlySet<string>;
}

export class FixtureAgentCliRunner implements AgentCliRunner {
  private cursor = 0;
  readonly performedCommands: string[] = [];

  /** Explicit verify outcomes consumed FIFO; falls back to the pay-script inference. */
  private readonly verifyQueue: boolean[] = [];

  constructor(
    private readonly payScript: FixturePayScript,
    private readonly state: FixtureState,
    private readonly options: {
      readonly mandateVerifyOk?: boolean;
      readonly mandateVerifyDetail?: string;
      readonly statusOk?: boolean;
      readonly payee?: string;
    } = {},
  ) {}

  /** Scripts the next mandateVerify outcome (FIFO). */
  expectVerify(ok: boolean): this {
    this.verifyQueue.push(ok);
    return this;
  }

  describePay(input: Parameters<AgentCliRunner['describePay']>[0]): string {
    return `npx -y @metalntwx/metal-agent pay ${input.url} --network testnet --mandate <redacted-path> [fixtures]`;
  }

  async pay(input: Parameters<AgentCliRunner['pay']>[0]): Promise<AgentPaymentResult> {
    this.performedCommands.push(`pay ${input.url}`);
    const entry = this.payScript[this.cursor];
    this.cursor += 1;
    const step = entry?.outcome;
    if (step === undefined) {
      return classify(
        1,
        '',
        '[fixture] pay lane exhausted with no scripted outcome (test bug — never silently loop)',
      );
    }
    if (step.kind === 'cli-failure') {
      return classify(1, '', `[fixture] ${step.message}`);
    }
    const exitCode =
      step.kind === 'paid' ? 0 : step.kind === 'pending' ? 3 : step.kind === 'held' ? 4 : 1;
    const lines: string[] = [`[fixture] outcome: ${step.kind}`];
    if (step.kind === 'paid' || step.kind === 'pending' || step.kind === 'held') {
      lines.push(`nonce: ${step.nonce}`);
    }
    if (step.kind === 'paid') {
      lines.push(`explorer: https://testnet.metalntwx.com/tx/${step.txHash}`);
      lines.push(`transaction hash: ${step.txHash}`);
    }
    if (step.kind === 'refused') {
      lines.push(
        step.atSettlement === true
          ? `payment refused at settlement: ${step.reason}`
          : `payment refused: ${step.reason}`,
      );
      // A refusal recorded on chain at settlement names its transaction (the
      // official CLI prints the hash when there is one); a pre-sign or
      // pre-settle refusal prints none.
      if (step.atSettlement === true) {
        lines.push(`transaction hash: 0x${'b'.repeat(64)}`);
        lines.push(`explorer: https://testnet.metalntwx.com/tx/0x${'b'.repeat(64)}`);
      }
      lines.push('nothing was paid');
    }
    if (step.kind === 'in-doubt') {
      lines.push(`payment in doubt at settlement: ${step.reason}`);
      lines.push(`transaction hash: ${step.txHash}`);
    }
    return classify(exitCode, lines.join('\n'), '');
  }

  async status(input: Parameters<AgentCliRunner['status']>[0]): Promise<AgentVerifyResult> {
    this.performedCommands.push(`status ${input.txHash}`);
    return { ok: this.options.statusOk ?? true, detail: '[fixture] status read' };
  }

  async mandateVerify(
    input: Parameters<AgentCliRunner['mandateVerify']>[0],
  ): Promise<AgentVerifyResult> {
    this.performedCommands.push(
      `mandate verify${input.txHash !== null ? ` --tx ${input.txHash}` : ''}`,
    );
    // The verify outcome is SCRIPTED per pay step (paid → verifiable; a
    // refused-at-settlement or in-doubt tx cannot verify as a successful
    // mandate transfer), or forced by mandateVerifyOk for the reconcile
    // path — which re-verifies a payment the SCRIPT already settled.
    const scripted = this.payScript[this.cursor - 1]?.outcome;
    const settledOnChain =
      scripted?.kind === 'paid' ||
      (scripted?.kind === 'refused' && scripted.atSettlement === true) ||
      scripted?.kind === 'in-doubt';
    const ok =
      this.verifyQueue.length > 0
        ? (this.verifyQueue.shift() as boolean)
        : (this.options.mandateVerifyOk ?? settledOnChain);
    return {
      ok,
      detail: ok
        ? '[fixture] mandate binding verified on chain; credential valid under issuer; payment verified as the mandate key’s own signed per-payment mandate'
        : '[fixture] mandate verification FAILED: the payment could not be rebuilt from the transaction',
    };
  }
}
