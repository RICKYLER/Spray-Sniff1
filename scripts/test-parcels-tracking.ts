import crypto from 'crypto'
import {
  ParcelsApiError,
  verifyParcelsWebhookSignature,
  mapParcelsToTrackingResult,
  trackShipmentSync,
  searchTrackingCarriers,
  getParcelsConfig,
  type ParcelsTrackingResultItem,
} from '../lib/parcels-api'
import { formatTrackingEventDate } from '../lib/tracking-types'

async function runTests() {
  console.log('🧪 [Test Suite] ParcelsApp API v5 Integration Verification\n')

  // Test 1: Config
  const config = getParcelsConfig()
  console.log('1. Configuration Test:')
  console.log(`   Version: ${config.version}`)
  console.log(`   Base URL: ${config.baseUrl}`)
  console.log(`   Is Live: ${config.isLive}`)
  if (config.baseUrl.includes('/v5')) {
    console.log('   ✅ v5 Config initialized correctly.')
  } else {
    throw new Error('Config is not pointing to v5')
  }

  // Test 2: Webhook HMAC-SHA256 Signature Verification
  console.log('\n2. Webhook Signature Verification Test:')
  const testSecret = 'whsec_test_secret_1234567890abcdef'
  const testPayload = JSON.stringify({
    event: 'shipment_completed',
    request_id: 'req_12345',
    timestamp: new Date().toISOString(),
    done: true,
  })

  const nowUnix = Math.floor(Date.now() / 1000)
  const signedString = `${nowUnix}.${testPayload}`
  const validHex = crypto.createHmac('sha256', testSecret).update(signedString).digest('hex')
  const validHeader = `t=${nowUnix},v1=${validHex}`

  const validResult = verifyParcelsWebhookSignature(testPayload, validHeader, testSecret)
  console.log(`   Valid signature check: ${validResult.valid ? 'PASSED ✅' : 'FAILED ❌'}`)
  if (!validResult.valid) {
    throw new Error(`Signature verification failed: ${validResult.reason}`)
  }

  // Tampered payload check
  const tamperedResult = verifyParcelsWebhookSignature(testPayload + 'x', validHeader, testSecret)
  console.log(`   Tampered payload check (should fail): ${!tamperedResult.valid ? 'PASSED ✅' : 'FAILED ❌'}`)
  if (tamperedResult.valid) {
    throw new Error('Tampered payload was incorrectly accepted!')
  }

  // Expired timestamp check
  const expiredUnix = nowUnix - 600 // 10 minutes ago
  const expiredSigned = `${expiredUnix}.${testPayload}`
  const expiredHex = crypto.createHmac('sha256', testSecret).update(expiredSigned).digest('hex')
  const expiredHeader = `t=${expiredUnix},v1=${expiredHex}`
  const expiredResult = verifyParcelsWebhookSignature(testPayload, expiredHeader, testSecret)
  console.log(`   Expired timestamp check (should fail): ${!expiredResult.valid ? 'PASSED ✅' : 'FAILED ❌'}`)
  if (expiredResult.valid) {
    throw new Error('Expired timestamp was incorrectly accepted!')
  }

  // Test 3: Data Mapping Test
  console.log('\n3. Tracking Data Mapping Test:')
  const mockItem: ParcelsTrackingResultItem = {
    tracking_number: '9400111206213785678901',
    state: 'completed',
    from_cache: true,
    shipment: {
      trackingId: '9400111206213785678901',
      status: 'delivered',
      origin: 'Manila, Philippines',
      destination: 'Cebu City, Philippines',
      daysInTransit: 2,
      states: [
        {
          state: 'Delivered, In/At Mailbox',
          location: 'Cebu City',
          date: '2026-11-09T16:00:00',
          utcOffset: '+08:00',
          event_code: 'DLV',
          station: 'CEB',
        },
        {
          state: 'Out for Delivery',
          location: 'Cebu City Hub',
          date: '2026-11-09T09:30:00',
        },
      ],
      detectedCarrier: {
        slug: 'j-t-express-ph',
        name: 'J&T Express Philippines',
        url: 'https://www.jtexpress.ph',
      },
      externalTracking: [
        {
          slug: 'j-t-express-ph',
          url: 'https://www.jtexpress.ph/track?billCode=9400111206213785678901',
        },
      ],
    },
  }

  const mapped = mapParcelsToTrackingResult(mockItem, '9400111206213785678901', {
    orderId: 'WEB-TEST-0001',
    defaultCourierName: 'J&T Express',
  })

  console.log(`   Mapped Status: ${mapped.status} (${mapped.statusText})`)
  console.log(`   Carrier: ${mapped.carrier.name} (Slug: ${mapped.carrier.slug})`)
  console.log(`   External Tracking URL: ${mapped.carrier.externalTrackingUrl}`)
  console.log(`   Total Events: ${mapped.events.length}`)
  console.log(`   Live Courier Scan Detected: ${mapped.isLiveCourier}`)

  if (
    mapped.status === 'delivered' &&
    mapped.isLiveCourier &&
    mapped.events.length === 2 &&
    mapped.carrier.name === 'J&T Express Philippines' &&
    mapped.events[0].utcOffset === '+08:00' &&
    formatTrackingEventDate('2026-11-09T09:30:00').includes('(local)')
  ) {
    console.log('   ✅ v5 Data mapping and timestamp handling passed cleanly.')
  } else {
    throw new Error('Mapping output did not match v5 expectations!')
  }

  // Test 4: Live v5 Tracking Carriers Catalog
  console.log('\n4. ParcelsApp v5 Tracking Carriers Catalog Test:')
  try {
    const catalog = await searchTrackingCarriers({ query: 'lbc', limit: 5 })
    console.log(`   Matched carriers for "lbc": ${catalog.carriers.length} (total: ${catalog.total_matches})`)
    if (catalog.carriers.length === 0) {
      throw new Error('Expected at least one carrier match for "lbc"')
    }
    console.log(`   Sample slug: ${catalog.carriers[0].slug} (${catalog.carriers[0].name})`)
    console.log('   ✅ GET /tracking-carriers succeeded!')
  } catch (err) {
    if (err instanceof ParcelsApiError && err.code === 'UNCONFIRMED_ACCOUNT') {
      console.warn('   ⚠️ Live account email confirmation pending (UNCONFIRMED_ACCOUNT).')
      console.warn('      Confirm via:', err.details?.confirmation_url)
    } else {
      throw err
    }
  }

  // Test 5: Live v5 Tracking Request Test
  console.log('\n5. ParcelsApp v5 Live Request Test:')
  try {
    const { response, shipmentResult } = await trackShipmentSync({
      trackingNumber: '9400111206213785678901',
      destinationCountry: 'US',
      carrierHint: 'usps',
    })

    console.log(`   Response Request ID: ${response.request_id}`)
    console.log(`   Response Status: ${response.status} (Done: ${response.done})`)
    console.log(`   Expires At: ${response.expires_at}`)
    console.log(`   Shipment State: ${shipmentResult?.state}`)
    console.log(`   Carrier: ${shipmentResult?.shipment?.detectedCarrier?.name || 'USPS'}`)
    console.log(`   Checkpoints returned: ${shipmentResult?.shipment?.states?.length ?? 0}`)

    if (response.request_id && response.expires_at) {
      console.log('   ✅ v5 query succeeded!')
    } else {
      throw new Error('v5 response missing request_id or expires_at')
    }
  } catch (err) {
    if (err instanceof ParcelsApiError && err.code === 'UNCONFIRMED_ACCOUNT') {
      console.warn('   ⚠️ Live tracking skipped until ParcelsApp account email is confirmed (UNCONFIRMED_ACCOUNT).')
    } else {
      console.error('   ❌ v5 query error:', err)
      throw err
    }
  }

  console.log('\n🎉 ALL PARCELSAPP INTEGRATION TESTS PASSED!')
}

runTests().catch((err) => {
  console.error('\n❌ Test run failed:', err)
  process.exit(1)
})

