import secp256k1 from 'secp256k1'

import { TypeRegistry } from '@polkadot/types'
import { u8aConcat } from '@polkadot/util'

import { Types } from '@hoprnet/hopr-core-connector-interface'

import { Ticket } from './ticket'
import { Signature } from './signature'

class SignedTicket extends Uint8Array implements Types.SignedTicket {
  private _ticket?: Ticket
  private _signature?: Signature

  constructor(
    arr?: {
      bytes: Uint8Array
      offset: number
    },
    struct?: {
      signature: Signature
      ticket: Ticket
    }
  ) {
    if (arr != null && struct == null) {
      super(arr.bytes, arr.offset, SignedTicket.SIZE)
    } else if (arr == null && struct != null) {
      const ticket = struct.ticket.toU8a()
      if (ticket.length == Ticket.SIZE) {
        super(u8aConcat(struct.signature, ticket))
      } else if (ticket.length < Ticket.SIZE) {
        super(u8aConcat(struct.signature, ticket, new Uint8Array(Ticket.SIZE - ticket.length)))
      } else {
        throw Error(`Ticket is too big by ${ticket.length - Ticket.SIZE} elements.`)
      }
    } else {
      throw Error(`Invalid constructor arguments.`)
    }
  }

  subarray(begin: number = 0, end?: number): Uint8Array {
    return new Uint8Array(this.buffer, this.byteOffset + begin, end != null ? end - begin : undefined)
  }

  get ticket(): Ticket {
    const registry = new TypeRegistry()
    registry.register(Ticket)

    if (this._ticket == null) {
      this._ticket = new Ticket(registry, this.subarray(Signature.SIZE, Signature.SIZE + Ticket.SIZE))
    }

    return this._ticket
  }

  get signature(): Signature {
    if (this._signature == null) {
      this._signature = new Signature({
        bytes: this.buffer,
        offset: this.byteOffset
      })
    }

    return this._signature
  }

  static get SIZE() {
    return Signature.SIZE + Ticket.SIZE
  }

  get signer(): Promise<Uint8Array> {
    return new Promise<Uint8Array>(async (resolve, reject) => {
      try {
        resolve(
          secp256k1.recover(
            Buffer.from(this.signature.sr25519PublicKey),
            Buffer.from(this.signature.signature),
            this.signature.recovery
          )
        )
      } catch (err) {
        reject(err)
      }
    })
  }
}

export { SignedTicket }