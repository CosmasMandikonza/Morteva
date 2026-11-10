/**
 * Official CLI runner — the ONLY execution boundary for sponsor payments.
 *
 * The adapter shells out to the OFFICIAL sponsor tooling
 * (`npx -y @metalntwx/metal-agent …`, package version pinned in
 * SPONSOR_AGENT_PACKAGE) exactly as its README documents, and classifies the
 * outcomes the README guarantees:
 *   `payment refused: <reason>`                     → nothing moved
 *   `payment refused at settlement: <reason>` (+tx) → nothing moved, hash known
 *   `payment in doubt at settlement: <reason>`      → MAY have settled
 *   exit codes (mandate pull): paid 0 / refused 1 / pending 3 / held 4
 *   refusal reasons under a mandate carry `mandate_*` codes (e.g. mandate_cap_exceeded)
 *
 * Security boundary: this module passes PATHS and URLs to the CLI. It never
 * reads key material, never logs the RPC endpoint (credential-bearing) or
 * key paths, and the MODEL can never choose a key, mandate or limit — the
 * caller fixes them from config before any run (official MCP semantics).
 */
import { spawn } from 'node:child_process';
import { SPONSOR_AGENT_PACKAGE } from './config.js';

export type PaymentPhase =
  | 'paid'
  | 'refused'
  | 'refused-at-settlement'
  | 'in-doubt-at-settlement'
  | 'pending'
  | 'held'
  | 'failed';

export interface AgentPaymentResult {
  readonly phase: PaymentPhase;
  /** The nonce the CLI prints as soon as it signs (undefined when refused pre-sign). */
  readonly nonce: string | null;
  /** Transaction hash when the CLI/chain reported one (explorer line or refusal). */
  readonly txHash: string | null;
  /** The explorer page URL when printed. */
  readonly explorerUrl: string | null;
  /** The refusal reason verbatim (`mandate_*` under a mandate, or x402 reason). */
  readonly refusalReason: string | null;
  /** Whether anything moved on chain. */
  readonly movedValue: boolean;
  readonly rawOutput: string;
}

export interface AgentVerifyResult {
  readonly ok: boolean;
  /** Verified binding/credential/payment records as the CLI reports them. */
  readonly detail: string;
}

export interface AgentCliRunner {
  /** `metal-agent pay <url> --network testnet --mandate <credential> [--rpc-url <endpoint>]` */
  pay(input: {
    readonly url: string;
    readonly mandateCredentialPath: string;
    readonly rpcUrl: string | null;
    readonly method?: 'GET' | 'POST';
    readonly body?: string;
    readonly network: 'testnet';
  }): Promise<AgentPaymentResult>;
  /** `metal-agent status <txHash> --network testnet --rpc-url <endpoint>` */
  status(input: { readonly txHash: string; readonly rpcUrl: string; readonly network: 'testnet' }): Promise<AgentVerifyResult>;
  /** `metal-agent mandate verify --credential <c> --issuer <pub> [--tx <hash> --signed-offer <text>] --rpc-url <endpoint>` */
  mandateVerify(input: {
    readonly mandateCredentialPath: string;
    readonly issuerPublicKeyFile: string;
    readonly txHash: string | null;
    readonly signedOffer: string | null;
    readonly rpcUrl: string;
    readonly network: 'testnet';
  }): Promise<AgentVerifyResult>;
  /** The command line that WOULD run — for gated smokes to print without executing. */
  describePay(input: {
    readonly url: string;
    readonly mandateCredentialPath: string;
    readonly rpcUrl: string | null;
    readonly network: 'testnet';
  }): string;
}

function classify(
  exitCode: number,
  stdout: string,
  stderr: string,
): AgentPaymentResult {
  const output = `${stdout}\n${stderr}`;
  const nonceMatch = /nonce[:= ]+([0-9a-fx-]+)/i.exec(output);
  const explorerMatch = /explorer[: ]+(\S+)/i.exec(output);
  const txMatch =
    /(?:transaction hash|tx|hash)[:= ]+((0x)?[0-9a-fA-F]{64})/i.exec(output) ??
    /((0x)?[0-9a-fA-F]{64})/.exec(
      stdout.includes('refused at settlement') ? stdout : '',
    );
  const refusedMatch = /payment refused(?: at settlement)?: (.+)$/im.exec(output);
  const inDoubtMatch = /payment in doubt at settlement: (.+)$/im.exec(output);

  let phase: PaymentPhase;
  let movedValue = false;
  if (inDoubtMatch !== null) {
    phase = 'in-doubt-at-settlement';
    movedValue = true; // "it may have settled" — ambiguous by definition
  } else if (refusedMatch !== null) {
    phase = refusedMatch[0].toLowerCase().includes('at settlement')
      ? 'refused-at-settlement'
      : 'refused';
  } else if (exitCode === 0) {
    phase = 'paid';
    movedValue = true;
  } else if (exitCode === 3) {
    phase = 'pending';
    movedValue = true; // a pending pull may settle
  } else if (exitCode === 4) {
    phase = 'held';
    movedValue = true; // held in escrow by the payee's receive policy
  } else {
    phase = 'failed';
  }
  return {
    phase,
    nonce: nonceMatch?.[1] ?? null,
    txHash: txMatch?.[1]?.toLowerCase() ?? null,
    explorerUrl: explorerMatch?.[1] ?? null,
    refusalReason:
      refusedMatch?.[1]?.trim() ?? inDoubtMatch?.[1]?.trim() ?? (phase === 'failed' ? output.slice(0, 400) : null),
    movedValue,
    rawOutput: output.slice(0, 4000),
  };
}

function buildPayArgs(input: {
  readonly url: string;
  readonly mandateCredentialPath: string;
  readonly rpcUrl: string | null;
  readonly method?: 'GET' | 'POST';
  readonly body?: string;
  readonly network: 'testnet';
}): readonly string[] {
  const args = ['-y', SPONSOR_AGENT_PACKAGE, 'pay', input.url, '--network', input.network, '--mandate', input.mandateCredentialPath];
  if (input.rpcUrl !== null && input.rpcUrl !== '') args.push('--rpc-url', input.rpcUrl);
  if (input.method !== undefined) args.push('--method', input.method);
  if (input.body !== undefined) args.push('--body', input.body);
  return args;
}

export function payCommandLine(input: {
  readonly url: string;
  readonly mandateCredentialPath: string;
  readonly rpcUrl: string | null;
  readonly network: 'testnet';
  readonly method?: 'GET' | 'POST';
  readonly body?: string;
}): string {
  const args = buildPayArgs(input);
  const printable = args
    .map((arg) =>
      arg === input.mandateCredentialPath || arg === input.rpcUrl
        ? '<redacted-path>'
        : arg,
    )
    .join(' ');
  return `npx ${printable}`;
}

export class NpxAgentCliRunner implements AgentCliRunner {
  constructor(
    private readonly options: {
      readonly timeoutMs?: number;
      readonly env?: NodeJS.ProcessEnv;
    } = {},
  ) {}

  describePay(input: Parameters<AgentCliRunner['describePay']>[0]): string {
    return payCommandLine(input);
  }

  private run(args: readonly string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn('npx', args, {
        env: this.options.env ?? process.env,
        shell: process.platform === 'win32',
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`metal-agent timed out after ${String(timeoutMs)}ms — no outcome is known; treat the payment as IN DOUBT`));
      }, timeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });
  }

  async pay(input: Parameters<AgentCliRunner['pay']>[0]): Promise<AgentPaymentResult> {
    const timeoutMs = this.options.timeoutMs ?? 120_000;
    const args = buildPayArgs(input);
    const { code, stdout, stderr } = await this.run(args, timeoutMs);
    return classify(code, stdout, stderr);
  }

  async status(input: Parameters<AgentCliRunner['status']>[0]): Promise<AgentVerifyResult> {
    const args = ['-y', SPONSOR_AGENT_PACKAGE, 'status', input.txHash, '--network', input.network, '--rpc-url', input.rpcUrl];
    const { code, stdout, stderr } = await this.run(args, this.options.timeoutMs ?? 60_000);
    return { ok: code === 0, detail: `${stdout}\n${stderr}`.slice(0, 4000) };
  }

  async mandateVerify(input: Parameters<AgentCliRunner['mandateVerify']>[0]): Promise<AgentVerifyResult> {
    const args = [
      '-y',
      SPONSOR_AGENT_PACKAGE,
      'mandate',
      'verify',
      '--credential',
      input.mandateCredentialPath,
      '--issuer',
      input.issuerPublicKeyFile,
      '--rpc-url',
      input.rpcUrl,
      '--network',
      input.network,
    ];
    if (input.txHash !== null) args.push('--tx', input.txHash);
    if (input.signedOffer !== null) args.push('--signed-offer', input.signedOffer);
    const { code, stdout, stderr } = await this.run(args, this.options.timeoutMs ?? 90_000);
    return { ok: code === 0, detail: `${stdout}\n${stderr}`.slice(0, 4000) };
  }
}

export { classify };
