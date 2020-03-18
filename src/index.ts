import { ApiPromise, WsProvider } from '@polkadot/api'
import Keyring from '@polkadot/keyring'
import type { KeyringPair } from '@polkadot/keyring/types'
import type { LevelUp } from 'levelup'
import { EventSignalling } from './events'
import { Types, SRMLTypes, Balance, State, Public, Hash } from './srml_types'
import { randomBytes } from 'crypto'
import { waitReady } from '@polkadot/wasm-crypto'
import * as Utils from './utils'
import * as DbKeys from './dbKeys'
import * as Constants from './constants'
import { DEFAULT_URI, DEMO_ACCOUNTS } from './config'
import secp256k1 from 'secp256k1'
 
import { Channel } from './channel'

import HoprCoreConnector, { Utils as IUtils, Types as ITypes, Channel as IChannel, DbKeys as IDbKeys } from '@validitylabs/hopr-core-connector-interface'

export { Types, Utils } 

export type HoprPolkadotProps = {
  self: KeyringPair
  api: ApiPromise
  db: LevelUp
}

export type HoprKeyPair = {
  privateKey: Uint8Array
  publicKey: Uint8Array
  onChainKeyPair: KeyringPair
}

class HoprPolkadot implements HoprCoreConnector {
  private _started: boolean = false
  private _nonce?: number

  eventSubscriptions: EventSignalling

  constructor(public api: ApiPromise, public self: HoprKeyPair, public db: LevelUp) {
    this.eventSubscriptions = new EventSignalling(this.api)
  }

  /**
   * Returns the current account nonce and lazily caches the result.
   */
  get nonce(): Promise<number> {
    if (this._nonce != null) {
      return Promise.resolve(this._nonce++)
    }

    return new Promise<number>(async (resolve, reject) => {
      try {
        this._nonce = (await this.api.query.system.accountNonce(this.self.onChainKeyPair.publicKey)).toNumber()
      } catch (err) {
        return reject(err)
      }

      return resolve(this._nonce++)
    })
  }

  /**
   * Starts the connector and initializes the internal state.
   */
  async start(): Promise<void> {
    await waitReady()

    this._started = true
  }

  get started(): boolean {
    return this._started
  }

  /**
   * Initializes the values that we store per user on-chain.
   * @param nonce set nonce manually for batch operations
   */
  async initOnchainValues(nonce?: number): Promise<void> {
    let secret = new Uint8Array(randomBytes(32))

    const dbPromise = this.db.put(Buffer.from(this.dbKeys.OnChainSecret()), secret.slice())

    for (let i = 0; i < 500; i++) {
      secret = await this.utils.hash(secret)
    }

    await Promise.all([
      this.api.tx.hopr
        .init(this.api.createType('Hash', this.self.onChainKeyPair.publicKey), secret)
        .signAndSend(this.self.onChainKeyPair, { nonce: nonce != null ? nonce : await this.nonce }),
      dbPromise
    ])
  }

  /**
   * Stops the connector and interrupts the communication with the blockchain.
   */
  async stop(): Promise<void> {
    const promise = new Promise<void>(resolve => {
      this.api.once('disconnected', () => {
        resolve()
      })
    })

    this.api.disconnect()

    return promise
  }

  /**
   * Returns the current account balance.
   */
  get accountBalance(): Promise<Balance> {
    return this.api.query.balances.freeBalance<Balance>(this.api.createType('AccountId', this.self.onChainKeyPair.publicKey))
  }

  readonly utils = Utils as typeof IUtils

  readonly types = Types as typeof ITypes

  readonly channel = Channel as typeof IChannel

  readonly dbKeys = DbKeys as typeof IDbKeys

  readonly constants = Constants

  static constants = Constants

  /**
   * Creates an uninitialised instance.
   *
   * @param db database instance
   */
  static async create(
    db: LevelUp,
    seed?: Uint8Array,
    options?: {
      id: number,
      provider: string
    }
  ): Promise<HoprPolkadot> {
    const apiPromise = ApiPromise.create({
      provider: new WsProvider(options != null && options.provider ? options.provider : DEFAULT_URI),
      types: SRMLTypes
    })

    await waitReady()

    let hoprKeyPair: HoprKeyPair
    if (seed != null) {
      hoprKeyPair = {
        privateKey: seed,
        publicKey: secp256k1.publicKeyCreate(seed),
        onChainKeyPair: new Keyring({ type: 'sr25519' }).addFromSeed(seed, undefined, 'sr25519')
      }
    } else if (options != null && options.id != null && isFinite(options.id)) {
      if (options.id > DEMO_ACCOUNTS.length) {
        throw Error(
          `Unable to find demo account for index '${options.id}'. Please make sure that you have specified enough demo accounts.`
        )
      }

      const privateKey = Utils.stringToU8a(DEMO_ACCOUNTS[options.id])
      if (!secp256k1.privateKeyVerify(privateKey)) {
        throw Error(`Unable to import demo account at inde '${options.id}' because seed is not usable.`)
      }

      const publicKey = secp256k1.publicKeyCreate(privateKey)

      if (!secp256k1.publicKeyVerify(publicKey)) {
        throw Error(`Unable to import demo account at inde '${options.id}' because seed is not usable.`)
      }

      hoprKeyPair = {
        privateKey,
        publicKey,
        onChainKeyPair: new Keyring({ type: 'sr25519' }).addFromSeed(privateKey, undefined, 'sr25519')
      }
    } else {
      throw Error('Invalid input parameters.')
    }

    const api = await apiPromise

    const result = new HoprPolkadot(api, hoprKeyPair, db)
    if (!(await checkOnChainValues(api, db, hoprKeyPair.onChainKeyPair))) {
      await result.initOnchainValues()
    }

    return result
  }
}

async function checkOnChainValues(api: ApiPromise, db: LevelUp, keyPair: KeyringPair) {
  let offChain: boolean
  let secret: Uint8Array = new Uint8Array()
  try {
    secret = await db.get(Buffer.from(DbKeys.OnChainSecret()))
    offChain = true
  } catch (err) {
    if (err.notFound != true) {
      throw err
    }
    offChain = false
  }

  const state = await api.query.hopr.states<State>(keyPair.publicKey)
  const onChain =
    !Utils.u8aEquals(state.pubkey, new Uint8Array(Public.SIZE).fill(0x00)) ||
    !Utils.u8aEquals(state.secret, new Uint8Array(Hash.SIZE).fill(0x00))

  if (offChain != onChain) {
    if (offChain) {
      await api.tx.hopr.init(api.createType('Hash', keyPair.publicKey), secret).signAndSend(keyPair)
    } else {
      throw Error(`Key is present on-chain but not in our database.`)
    }
  }

  return offChain && onChain
}

export default HoprPolkadot
