// @ts-ignore
import abiDecoder from 'abi-decoder'
import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import sinon from 'sinon'
import sinonChai from 'sinon-chai'
import { ChildProcessWithoutNullStreams } from 'child_process'
import { HttpProvider } from 'web3-core'

import {
  ForwarderInstance,
  PenalizerInstance, RelayHubInstance,
  StakeManagerInstance,
  TestPaymasterEverythingAcceptedInstance,
  TestRecipientInstance
} from '@opengsn/contracts'
import { GsnTransactionDetails } from '@opengsn/common/dist/types/GsnTransactionDetails'
import { RelayTransactionRequest } from '@opengsn/common/dist/types/RelayTransactionRequest'
import { ServerConfigParams } from '@opengsn/relay/dist/ServerConfigParams'
import { arbitrumBaseRelayFeeBidModeParams, GSNConfig, RelayClient } from '@opengsn/provider'
import { environments } from '@opengsn/common/dist/Environments'
import { registerForwarderForGsn } from '@opengsn/common/dist/EIP712/ForwarderUtil'

import RelayHubABI from '@opengsn/common/dist/interfaces/IRelayHub.json'

import { ServerTestEnvironment } from '../ServerTestEnvironment'
import { configureGSN, deployHub, startRelay, stopRelay } from '../TestUtils'

const { expect, assert } = chai.use(chaiAsPromised).use(sinonChai)

const Forwarder = artifacts.require('Forwarder')
const Penalizer = artifacts.require('Penalizer')
const StakeManager = artifacts.require('StakeManager')
const TestRecipient = artifacts.require('TestRecipient')
const TestPaymasterEverythingAccepted = artifacts.require('TestPaymasterEverythingAccepted')

const underlyingProvider = web3.currentProvider as HttpProvider

abiDecoder.addABI(RelayHubABI)

contract('BaseRelayFee bidding mode', function (accounts: Truffle.Accounts) {
  const from = accounts[0]
  const relayOwner = accounts[1]

  const pctRelayFee = '10'
  const baseRelayFee = '1000000000000'

  let paymaster: TestPaymasterEverythingAcceptedInstance
  let testRecipient: TestRecipientInstance
  let stakeManager: StakeManagerInstance
  let forwarder: ForwarderInstance
  let penalizer: PenalizerInstance
  let relayHub: RelayHubInstance

  before(async function () {
    stakeManager = await StakeManager.new(environments.arbitrum.maxUnstakeDelay)
    penalizer = await Penalizer.new(
      environments.arbitrum.penalizerConfiguration.penalizeBlockDelay,
      environments.arbitrum.penalizerConfiguration.penalizeBlockExpiration,
      environments.arbitrum.penalizerConfiguration.penalizeExternalGasLimit)
    relayHub = await deployHub(stakeManager.address, penalizer.address, {}, environments.arbitrum)

    forwarder = await Forwarder.new()
    paymaster = await TestPaymasterEverythingAccepted.new()
    testRecipient = await TestRecipient.new(forwarder.address)
    await registerForwarderForGsn(forwarder)
    await paymaster.setTrustedForwarder(forwarder.address)
    await paymaster.setRelayHub(relayHub.address)
    await paymaster.deposit({ value: web3.utils.toWei('1', 'ether') })
  })

  describe('unit tests', function () {
    describe('RelayServer', function () {
      let env: ServerTestEnvironment
      let req: RelayTransactionRequest

      before(async function () {
        env = new ServerTestEnvironment(web3.currentProvider as HttpProvider, accounts)
        const relayClientConfig: Partial<GSNConfig> = {}
        await env.init(relayClientConfig)
        const overrideParams: Partial<ServerConfigParams> = {
          baseRelayFeeBidMode: true
        }
        await env.newServerInstance(overrideParams)
        await env.clearServerStorage()
        req = await env.createRelayHttpRequest()
      })

      it('should reject a request if a baseRelayFee bid is too low', async function () {
        req.relayRequest.relayData.baseRelayFee = '7777'
        try {
          await env.relayServer.createRelayTransaction(req)
          assert.fail()
        } catch (e) {
          assert.include(e.message, 'Refusing to relay a transaction in a baseRelayFeeBidMode. Proposed baseRelayFee: 7777')
        }
      })

      it('should reject a request if it specifies pctRelayFee', async function () {
        req.relayRequest.relayData.pctRelayFee = '7777'
        try {
          await env.relayServer.createRelayTransaction(req)
          assert.fail()
        } catch (e) {
          assert.include(e.message, 'This server is running in a baseRelayFee bid mode, setting pctRelayFee is forbidden!')
        }
      })
    })

    // TODO: RelayedTransactionValidator is not currently covered by tests
    describe('RelayedTransactionValidator', function () {
      it('should reject a transaction with a gas price below minAcceptableGasPrice')
    })

    describe('RelayHub', function () {
      it('should not accept externalGasLimit other than 0', async function () {})
      it('should not accept pctRelayFee other than 0', async function () {})
      it('should not accept gasPrice other than 0', async function () {})
      it('should not accept if baseRelayFee is higher than Paymaster balance', async function () {})
      it('should report to a Paymaster that maxPossibleGas is 0', async function () {})
      it('should report to a Paymaster that gasUseWithoutPost is 0', async function () {})
    })
    describe('Penalizer', function () {
      it('should not penalize externalGasLimit that does not match raw transaction data', async function () {})
    })
  })

  // TODO: reuse existing scaffolds to minimize code
  describe('integration test', function () {
    describe('RelayClient configured to run in baseRelayFeeBidMode', function () {
      let relayClient: RelayClient
      let gsnTransactionDetails: GsnTransactionDetails
      let relayProcess: ChildProcessWithoutNullStreams

      before(async function () {
        relayProcess = await startRelay(relayHub.address, stakeManager, {
          environmentName: 'arbitrum',
          baseRelayFeeBidMode: true,
          initialReputation: 100,
          stake: 1e18,
          pctRelayFee,
          baseRelayFee,
          relayOwner,
          ethereumNodeUrl: underlyingProvider.host
        })

        const gsnConfig: GSNConfig = configureGSN({
          baseRelayFeeBidModeParams: arbitrumBaseRelayFeeBidModeParams,
          loggerConfiguration: { logLevel: 'debug' },
          environment: environments.arbitrum,
          paymasterAddress: paymaster.address
        })
        relayClient = await new RelayClient({ provider: underlyingProvider, config: gsnConfig }).init()
        // as ganache returns values not similar to arbitrum, faking estimateGas is the
        // only way for the 'estimateGas()' result to exceed estimated calldataCost
        sinon.stub(relayClient.dependencies.contractInteractor.web3.eth, 'estimateGas')
          .callsFake(async function (): Promise<number> {
            return 1000000
          })
        sinon.spy(relayClient.dependencies.httpClient, 'relayTransaction')
        const data = testRecipient.contract.methods.emitMessage('hello world').encodeABI()
        gsnTransactionDetails = {
          from,
          to: testRecipient.address,
          data,
          paymasterData: '0x',
          clientId: '1'
        }
      })

      after(function () {
        stopRelay(relayProcess)
      })

      it('should relay a transaction with 0 gasPrice and pctRelayFee but sufficient baseRelayFee', async function () {
        const relayingResult = await relayClient.relayTransaction(gsnTransactionDetails)
        const allErrorsAsString = JSON.stringify(Array.from(relayingResult.relayingErrors.values()).map(it => it.stack))
        assert.equal(relayingResult.relayingErrors.size, 0, allErrorsAsString)
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        const transactionHash = '0x' + relayingResult.transaction!.hash().toString('hex')
        const transactionReceipt = await web3.eth.getTransactionReceipt(transactionHash)
        const logs = abiDecoder.decodeLogs(transactionReceipt.logs)
        const transactionRelayedEvent = logs.find((it: any) => it.name === 'TransactionRelayed')
        const actualChargeFromEvent: string = transactionRelayedEvent.events.find((it: any) => it.name === 'charge').value
        // verify that the relayed baseFee is exactly the charge amount the paymaster paid
        expect(relayClient.dependencies.httpClient.relayTransaction).to.have.been.calledWith(
          sinon.match.any,
          sinon.match.has('relayRequest', sinon.match.has('relayData', sinon.match.has('baseRelayFee', actualChargeFromEvent)))
        )
      })
    })
  })
})
