module.exports = {
  async retry(fn, retries = 3, delay = 2000) {
    for (let i = 0; i < retries; i++) {
      try { return await fn(); }
      catch (e) {
        if (i === retries - 1) throw e;
        await new Promise(r => setTimeout(r, delay * Math.pow(2, i)));
      }
    }
  },
  cosineSimilarity(v1, v2) {
    if (!v1 || !v2) return 0;
    const dot = v1.reduce((s, a, i) => s + a * v2[i], 0);
    const m1 = Math.sqrt(v1.reduce((s, a) => s + a * a, 0));
    const m2 = Math.sqrt(v1.reduce((s, a) => s + a * a, 0));
    return dot / (m1 * m2);
  }
};
