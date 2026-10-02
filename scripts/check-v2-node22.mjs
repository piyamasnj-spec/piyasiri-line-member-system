// Pin only the V2 validation runner, not Netlify/V1 build configuration.
export const requiredNode = '22.23.2';
export function assertNode22(version = process.versions.node) {
  if (version !== requiredNode) throw Error(`V2 validation requires Node ${requiredNode}; actual ${version}`);
}
assertNode22();
