// Test process preload. Live LINE/Firebase/Netlify calls are forbidden in offline suites.
globalThis.fetch = async () => {
  throw new Error('Network disabled in offline tests');
};
