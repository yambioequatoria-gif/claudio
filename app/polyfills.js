// pdf.js uses Map/WeakMap.getOrInsertComputed, which older Chromium-based browsers lack.
// This runs as a classic script before the module imports, so it is in place first.
for (const Ctor of [Map, WeakMap]) {
  if (!Ctor.prototype.getOrInsertComputed) {
    Object.defineProperty(Ctor.prototype, "getOrInsertComputed", {
      value(key, compute) {
        if (!this.has(key)) this.set(key, compute(key));
        return this.get(key);
      },
      writable: true,
      configurable: true,
    });
  }
}
