# DClawbot: Serverless OpenClaw Runtime on Kubernetes

This repository implements a serverless OpenClaw runtime using Kubernetes, scaled on-demand by SQS queue metrics with KEDA. 

---

## 1. Architecture Overview

### Concept
This system is an asynchronous event-driven serverless platform designed to scale OpenClaw agent runtimes from zero to many, and back to zero, based on SQS queue workloads.

- **Edge Layer:** A webhook receiver receives incoming messages, immediately acknowledges receipt to prevent timeouts (the "3-second rule" from messaging platforms), and posts the payload into an SQS queue.
- **Queue & Scaling Layer:** KEDA monitors SQS queue depth and provisions the agent worker pods on demand.
- **Compute & State Layer:** Worker pods pull the agent's SQLite state from Redis, write it to disk, run the prompt through OpenClaw, then push the updated SQLite back to Redis when the job finishes.

### Architecture Diagram
```mermaid
graph TD
    subgraph UserLayer ["User Layer (Edge)"]
        User["User"] --> DiscordWebhook["Discord Webhook"]
        DiscordWebhook --> CFWorker["Webhook Receiver"]
        CFWorker -- "200 OK (Instant)" --> DiscordWebhook
    end

    subgraph QueueLayer ["Queue Layer (Persistence)"]
        CFWorker --> SQS["AWS SQS / LocalStack SQS"]
    end

    subgraph ControlLayer ["Control Layer (K8s / Kind)"]
        KEDA["KEDA (Scale Controller)"]
        SQS -. "Metrics" .-> KEDA
    end

    subgraph ComputeLayer ["Compute Layer (Worker Isolation)"]
        Pod["OpenClaw Agent Pod"]
        KEDA --> Pod
    end

    subgraph StateLayer ["State Layer (Consistency)"]
        Redis["Redis Store"]
        Pod <--> Redis
        Note1["Full SQLite Snapshot (GET/SET)"] -.-> Redis
    end

    subgraph OutputLayer ["Output Layer (Async)"]
        DiscordAPI["Discord API"]
        Pod --> DiscordAPI
        DiscordAPI -- "Async Reply" --> User
    end
```

---

## 2. Architectural Assumptions

- **Availability < Consistency:** It is better for an agent to take an extra few seconds to wake up than to lose context or hallucinate because it lost state. We use synchronous Redis writes to guarantee that context is never lost.
- **Stateless Compute, Stateful Context:** The pods are disposable. On boot they grab the agent's SQLite DB from Redis, and after a successful run they push it back. If a pod dies, we just spin up another one and reload from the last good snapshot.
- **Isolation:** Multi-tenant scale requires gVisor or Kata Containers to prevent host kernel escapes when running untrusted user tools.

---

## 3. Drawbacks & Gotchas

- **The 429 Poison Pill:** If the output platform (e.g. Discord) rate-limits us, the Redis Stream can loop infinitely and crash the pod. A Dead Letter Stream is needed to catch, park, and back-off these messages.
- **NAT Gateway Costs:** At 10,000 users, data transfer for image pulls and API calls will be expensive. VPC Endpoints are critical to keep traffic internal to the AWS backbone.
- **The etcd Object Limit:** Running a 1:1 ratio of Tenant-to-KEDA ScaledObject will eventually overwhelm etcd. To scale safely beyond 5,000 tenants, we must abandon native KEDA per-tenant objects and write a custom Kubernetes Operator.
- **Concurrency & Silent Data Loss:** Right now there's a "last writer wins" race. If two messages for the same `agentId` hit the queue at nearly the same time, KEDA can scale up two pods that both read the same snapshot. They process independently, and whichever finishes last overwrites the other's work. The user never sees an error, they just lose state. To fix this properly we'd either lock to `maxReplicaCount: 1` (simple but kills throughput), use a Redlock per `agentId`, or move state into PostgreSQL with row-level locking.
- **Ephemeral Redis:** Redis in this prototype has no PVC and no AOF/RDB config. If the Redis pod restarts, all agent state is gone. For production this needs ElastiCache Multi-AZ with AOF turned on.

---

## 4. Cost Estimation (1,000 Users — Napkin Math)

OpenClaw delegates LLM calls to external APIs (OpenAI, Anthropic, etc), so our workers are just Node.js processes — no GPU nodes needed. My early design notes got this wrong and assumed we'd be running inference ourselves, which blew the estimates up to ~$3.50/user/month. After actually looking at how OpenClaw works, the real numbers are much lower.

Assuming 1,000 users, each active ~15 min/day (~3.75 hrs compute per user per month):

| Line Item | Monthly Cost | Notes |
| :--- | :--- | :--- |
| AWS EKS Control Plane | $73.00 | Fixed cost, single cluster. |
| Fargate Compute (3,750 hrs) | ~$150.00 | 0.25 vCPU / 0.5 GB per pod, on-demand rates. |
| ElastiCache Redis (cache.t4g.micro) | ~$16.00 | Single-node. Multi-AZ would double this. |
| SQS | $0.00 | Free tier covers ~1M requests/month. |
| **Total** | **~$239.00/month** | **~$0.24 per user/month** |

This doesn't include LLM API token costs (paid per-token by the customer or platform), NAT Gateway fees (~$0.045/GB), ECR storage, or CloudWatch. At 10k users NAT Gateway and data transfer start to dominate — VPC Endpoints become essential.

---

## 5. Local Development Bring-Up

### Step 1: Spin up the Environment & Deploy
Run the automation task using the provided `Makefile` to set up the Kind cluster, build the images, load them into Kind, and apply the manifests:

```bash
make all
```

This target performs the following:
1. Creates a Kind cluster named `dclawbot` (skips if it already exists).
2. Adds the KEDA Helm repo and installs KEDA on the cluster.
3. Builds the `worker:latest` and `webhook:latest` Docker images locally.
4. Loads those images into the `dclawbot` Kind cluster.
5. Deploys the worker and webhook resources.

### Step 2: Access the Webhook Service
Port-forward the webhook service to your localhost to receive payloads:

```bash
sudo kubectl port-forward svc/webhook 3000:80
```

Now, any webhooks directed to `http://localhost:3000` will be ingested by the receiver, placed in SQS, and trigger worker pods.

### Clean Up
To clean up and destroy the cluster:

```bash
make clean
```
