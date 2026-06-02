import fs from 'node:fs/promises';
import path from 'node:path';
import { exec } from 'node:child_process';
import Redis from 'ioredis';
import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';

const redisUrl = process.env.REDIS_URL || 'redis://redis:6379';
const queueUrl = process.env.SQS_QUEUE_URL || 'http://localstack:4566/000000000000/agent-requests';
const awsRegion = process.env.AWS_REGION || 'us-east-1';
const awsEndpoint = process.env.AWS_ENDPOINT || 'http://localstack:4566';
const openclawBootCommand = process.env.OPENCLAW_BOOT_COMMAND || 'npx openclaw';

const redis = new Redis(redisUrl);
const sqsClient = new SQSClient({
  region: awsRegion,
  endpoint: awsEndpoint,
  credentials: {
    accessKeyId: 'test',
    secretAccessKey: 'test',
  },
});

async function runOpenClawBot(agentId) {
  return new Promise((resolve, reject) => {
    console.log(`[Worker] Starting openclaw bot for agent ${agentId}...`);
    const child = exec(openclawBootCommand, {
      env: {
        ...process.env,
        OPENCLAW_AGENT_ID: agentId,
      }
    });

    child.stdout.on('data', (data) => console.log(`[OpenClaw stdout] ${data.trim()}`));
    child.stderr.on('data', (data) => console.error(`[OpenClaw stderr] ${data.trim()}`));

    child.on('close', (code) => {
      if (code === 0) {
        console.log(`[Worker] OpenClaw bot completed successfully.`);
        resolve();
      } else {
        reject(new Error(`OpenClaw exited with code ${code}`));
      }
    });
  });
}

async function processMessage(message) {
  let agentId;
  try {
    const payload = JSON.parse(message.Body);
    agentId = payload.agentId;
    if (!agentId) {
      throw new Error("Message body is missing 'agentId'");
    }
  } catch (err) {
    console.error('[Worker] Failed to parse message body:', err);
    return;
  }

  const redisKey = `agent:state:${agentId}`;
  const dbDir = path.join(process.env.HOME || '/root', '.openclaw', 'agents', agentId, 'agent');
  const dbPath = path.join(dbDir, 'openclaw-agent.sqlite');

  try {
    // 1. Download SQLite state from Redis if it exists
    console.log(`[Worker] Fetching state for agent ${agentId} from Redis...`);
    const stateBuffer = await redis.getBuffer(redisKey);

    // Ensure state directory exists
    await fs.mkdir(dbDir, { recursive: true });

    if (stateBuffer) {
      console.log(`[Worker] Writing state to disk at ${dbPath}`);
      await fs.writeFile(dbPath, stateBuffer);
    } else {
      console.log(`[Worker] No existing state found in Redis for agent ${agentId}. Starting fresh.`);
    }

    // 2. Run the OpenClaw bot
    await runOpenClawBot(agentId);

    // 3. Upload the updated SQLite state back to Redis
    if (await fs.stat(dbPath).catch(() => false)) {
      console.log(`[Worker] Uploading updated state for agent ${agentId} back to Redis...`);
      const updatedStateBuffer = await fs.readFile(dbPath);
      await redis.set(redisKey, updatedStateBuffer);
      console.log(`[Worker] State uploaded successfully.`);
    }

  } catch (error) {
    console.error(`[Worker] Error processing job for agent ${agentId}:`, error);
  }
}

async function pollQueue() {
  console.log('[Worker] Worker polling loop started...');
  while (true) {
    try {
      const command = new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 10,
      });

      const response = await sqsClient.send(command);

      if (response.Messages && response.Messages.length > 0) {
        const message = response.Messages[0];
        console.log(`[Worker] Received job: ${message.MessageId}`);

        await processMessage(message);

        const deleteCommand = new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: message.ReceiptHandle,
        });
        await sqsClient.send(deleteCommand);
        console.log(`[Worker] Job acknowledged and deleted: ${message.MessageId}`);
      }
    } catch (error) {
      console.error('[Worker] Error polling SQS queue:', error);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

pollQueue();
