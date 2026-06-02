import express from 'express';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;
const queueUrl = process.env.SQS_QUEUE_URL || 'http://localstack:4566/000000000000/agent-requests';
const awsRegion = process.env.AWS_REGION || 'us-east-1';
const awsEndpoint = process.env.AWS_ENDPOINT || 'http://localstack:4566';

const sqsClient = new SQSClient({
  region: awsRegion,
  endpoint: awsEndpoint,
  credentials: {
    accessKeyId: 'test',
    secretAccessKey: 'test',
  },
});

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    console.log('Received webhook request:', body);

    const command = new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(body),
    });

    const response = await sqsClient.send(command);
    console.log('Message sent successfully. MessageId:', response.MessageId);

    res.status(200).json({
      success: true,
      messageId: response.MessageId,
    });
  } catch (error) {
    console.error('Error sending message to SQS:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Liveness/Readiness probe
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.listen(port, () => {
  console.log(`Webhook server listening on port ${port}`);
});
