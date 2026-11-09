/**
 * GLB inspector for the MTV-09 asset gate (issue #11 evidence).
 *
 * Parses the binary glTF container: JSON chunk stats (meshes, primitives,
 * accessors → triangle/vertex counts, animations, materials, textures) and
 * node bounds → real dimensions + orientation. Run from repo root:
 *   node research/mtv-09/glb-inspect.mjs research/mtv-09/candidates/<file>.glb
 * No dependencies — reads the GLB structure directly.
 */
import { readFileSync } from 'node:fs';

function inspect(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${path}: not a GLB (magic)`);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));

  const prims = [];
  let triangles = 0;
  let vertices = 0;
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      const posAcc = json.accessors[prim.attributes.POSITION];
      const idxAcc = prim.indices !== undefined ? json.accessors[prim.indices] : null;
      const verts = posAcc.count;
      const tris = idxAcc ? idxAcc.count / 3 : verts / 3;
      vertices += verts;
      triangles += tris;
      prims.push({
        mesh: mesh.name ?? '(unnamed)',
        material: json.materials?.[prim.material]?.name ?? '(default)',
        verts,
        tris: Math.round(tris),
      });
    }
  }

  // Bounds over POSITION accessors only (normals/tangents are also VEC3 and
  // would poison a global scan).
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      const acc =
        json.accessions?.[prim.attributes.POSITION] ?? json.accessors[prim.attributes.POSITION];
      if (acc?.min === undefined || acc?.max === undefined) continue;
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i], acc.min[i]);
        max[i] = Math.max(max[i], acc.max[i]);
      }
    }
  }
  const dims =
    min[0] !== Infinity ? max.map((m, i) => Math.round((m - min[i]) * 1000) / 1000) : null;

  const textures = (json.images ?? []).map((img) => ({
    mime: img.mimeType,
    name: img.name ?? img.uri ?? '(embedded)',
  }));
  const materials = (json.materials ?? []).map((m) => m.name ?? '(default)');
  const animations = (json.animations ?? []).map((a) => ({
    name: a.name ?? '(unnamed)',
    channels: a.channels?.length ?? 0,
  }));
  const scenes = json.scenes?.length ?? 0;
  const nodes = json.nodes?.length ?? 0;
  const hasKhrDraco = JSON.stringify(json.extensionsUsed ?? []).includes('DRACO');
  const hasMeshopt = JSON.stringify(json.extensionsUsed ?? []).includes('EXT_meshopt_compression');

  console.log(`\n=== ${path} ===`);
  console.log(`generator: ${json.asset?.generator ?? '(none)'}`);
  console.log(
    `triangles: ${Math.round(triangles)} | vertices: ${vertices} | primitives: ${prims.length} | meshes: ${json.meshes?.length ?? 0}`,
  );
  console.log(
    `nodes: ${nodes} | scenes: ${scenes} | animations: ${animations.length ? JSON.stringify(animations) : 'none'}`,
  );
  console.log(
    `dimensions (min→max per accessor bounds): ${dims ? `${dims[0]} × ${dims[1]} × ${dims[2]} (x,y,z)` : 'mixed — see accessor scan'}`,
  );
  console.log(
    `materials (${materials.length}): ${materials.slice(0, 12).join(', ')}${materials.length > 12 ? '…' : ''}`,
  );
  console.log(
    `textures: ${textures.length ? textures.map((t) => `${t.mime}:${t.name}`).join(', ') : 'none (vertex colors / materials only)'}`,
  );
  console.log(`compressed: draco=${hasKhrDraco} meshopt=${hasMeshopt}`);
  for (const p of prims.slice(0, 14))
    console.log(`  prim: ${p.mesh} [${p.material}] v=${p.verts} t=${p.tris}`);
}

for (const arg of process.argv.slice(2)) {
  try {
    inspect(arg);
  } catch (error) {
    console.error(`${arg}: INSPECT FAILED — ${error.message}`);
    process.exitCode = 1;
  }
}
