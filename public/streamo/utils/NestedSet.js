export class NestedSet {
  #map = new Map()
  #set = new Set()

  get size () {
    return this.values().length
  }

  add (root, ...rest) {
    if (rest.length) {
      if (!this.#map.has(root)) this.#map.set(root, new NestedSet())
      return this.#map.get(root).add(...rest)
    }
    return this.#set.add(root)
  }

  get (root, ...rest) {
    if (rest.length) return this.#map.get(root)?.get(...rest)
    return this.#map.get(root)
  }

  delete (root, ...rest) {
    if (rest.length) {
      this.#map.get(root)?.delete(...rest)
    } else {
      this.#set.delete(root)
      this.#map.forEach(nested => nested.delete(root))
    }
    if (!this.#map.get(root)?.size) this.#map.delete(root)
  }

  deleteBranch (root, ...rest) {
    if (rest.length) return this.#map.get(root)?.deleteBranch(...rest)
    return this.#map.delete(root)
  }

  values (...path) {
    if (path.length) return this.#map.get(path[0])?.values(...path.slice(1)) ?? []
    return [...new Set([...this.#set, ...[...this.#map.keys()].flatMap(k => this.values(k))])]
  }
}
