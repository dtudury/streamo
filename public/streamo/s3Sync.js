import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3'
import { S3Client } from '@aws-sdk/client-s3'

/**
 * Count objects in S3 with the given prefix (handles pagination).
 */
async function listFrameCount (client, bucket, prefix) {
  let count = 0
  let token
  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix + '/',
      ContinuationToken: token
    }))
    count += res.KeyCount ?? 0
    token = res.NextContinuationToken
  } while (token)
  return count
}

async function downloadFrame (client, bucket, key) {
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  return new Uint8Array(await res.Body.transformToByteArray())
}

async function uploadFrame (client, bucket, key, data) {
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: data }))
}

/**
 * Sync a Stream to/from S3-compatible object storage.
 *
 * Each wire-format frame is stored as a separate numbered object:
 *   <publicKeyHex>/000000
 *   <publicKeyHex>/000001
 *   ...
 *
 * On startup, existing frames are downloaded in order and fed into the stream.
 * New frames are uploaded as they arrive.
 *
 * @param {import('./Stream.js').Stream} stream
 * @param {string} publicKeyHex
 * @param {object} config
 * @param {string} config.bucket
 * @param {string} [config.endpoint]
 * @param {string} [config.region]
 * @param {string} [config.accessKeyId]
 * @param {string} [config.secretAccessKey]
 */
export async function s3Sync (stream, publicKeyHex, config) {
  const { bucket, endpoint, region, accessKeyId, secretAccessKey } = config

  const client = new S3Client({
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    ...(region ? { region } : {}),
    ...(accessKeyId && secretAccessKey
      ? { credentials: { accessKeyId, secretAccessKey } }
      : {})
  })

  const keyFor = i => `${publicKeyHex}/${String(i).padStart(6, '0')}`

  // Load existing frames from S3 into the stream
  let frameCount = 0
  try {
    frameCount = await listFrameCount(client, bucket, publicKeyHex)
    if (frameCount > 0) {
      console.log(`[s3] loading ${frameCount} frames for ${publicKeyHex.slice(0, 8)}...`)
      const writer = stream.makeWritableStream().getWriter()
      for (let i = 0; i < frameCount; i++) {
        const frame = await downloadFrame(client, bucket, keyFor(i))
        await writer.write(frame)
      }
    }
  } catch (e) {
    console.error('[s3] load error:', e.message)
  }

  // Upload new frames as they arrive, skipping already-uploaded ones
  let uploaded = 0
  const reader = stream.makeReadableStream().getReader()
  ;(async () => {
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (uploaded < frameCount) {
          uploaded++ // skip frames we just loaded
          continue
        }
        await uploadFrame(client, bucket, keyFor(uploaded), value)
        uploaded++
      }
    } catch (e) {
      console.error('[s3] upload error:', e.message)
    }
  })()
}
