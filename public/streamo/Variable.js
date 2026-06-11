// Universal carrier for an encoded value. Either inline (the encoding
// sits in `bytes`, embedded in a parent chunk) or addressed (the chunk
// is stored in some registry at `address`).
//
// CodecRegistry.append throws on Variable. `variable.materialize(r)` is
// the explicit opt-in to turn inline → addressed.

export class Variable {
  #codec
  #bytes
  #address

  static inline (codec, bytes) {
    const v = new Variable()
    v.#codec = codec
    v.#bytes = bytes
    return v
  }

  static addressed (codec, address) {
    const v = new Variable()
    v.#codec = codec
    v.#address = address
    return v
  }

  get codec ()       { return this.#codec }
  get isInline ()    { return this.#bytes !== undefined }
  get isAddressed () { return this.#address !== undefined }
  get bytes ()       { return this.#bytes }
  get address ()     { return this.#address }

  resolve (r) {
    if (this.isInline) return this.#bytes
    return r.resolve(this.#address)
  }

  materialize (r) {
    if (this.isAddressed) return this
    const existing = r.addressOf(this.#bytes)
    const address = existing ?? r.append(this.#bytes)
    return Variable.addressed(this.#codec, address)
  }
}
