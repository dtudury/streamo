export class Opaque {
  constructor (value) {
    if (!(value instanceof Uint8Array)) throw new TypeError('Opaque: expects a Uint8Array')
    this.value = value
  }
}
