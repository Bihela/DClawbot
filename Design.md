# Architectural Design: Serverless OpenClaw Runtime
**Candidate:** Bihela

Basically the first was Knative Serving. It is the industry standard for scale-to-zero on Kubernetes, and it handles the heavy lifting of routing and pod autoscaling natively. For state, I figured the agents could simply flush their memory to a EBS or an S3 bucket whenever they received a termination signal.

But there is the 3-second rule. Messaging platforms like Discord and WhatsApp are notoriously impatient; if they don't receive an HTTP 200 acknowledgment within three seconds, they drop the connection and show the user an error. Since a cold start even a fast one involves scheduling a pod and pulling an image, we are realistically looking at 15 to 20 seconds of latency. Furthermore, relying on a terminal flush for state is a gamble. On AWS Spot Instances, if a node is reclaimed forcefully, that "save" command might never finish, leading to silent data loss and "amnesia" for the AI agent.

To bridge that 15-second gap, I shifted focus to AWS SOCI (Seekable OCI). By lazy-loading the container image, we can get the application up and running before the full 10GB image is even on the disk. To handle the Discord timeout, I looked at the KEDA HTTP Add-on, which uses an interceptor to "hold" the incoming request in a buffer while KEDA spins up the pod.

While this looked great in a lab setting, it felt like a "tarpit" for production. If 1,000 users all message their agents at the same time on a Monday morning, the interceptor would be holding thousands of open TCP connections in its own RAM. If that interceptor crashes or OOMs, every single buffered message is gone forever. Additionally, I found that Knative’s internal sidecars often hijack the very hooks we need to save state. I realized I was fighting the framework rather than using it,long-term won't make sense to have this.

For this issue the system had to be asynchronous. I decided to move the acknowledgment logic to the edge using a Cloudflare Worker. This worker intercepts the webhook, immediately tells Discord "I got it," and then drops the payload into an AWS SQS queue. This effectively decoupled the user experience from the Kubernetes cold start.

To solve the state loss problem, I moved away from "saving on shutdown" and implemented Continuous Write-Ahead Logging (WAL) to Redis ElastiCache. By streaming every conversational turn to Redis in real-time, the pod became "disposable." If it crashed, no big deal the next pod would just replay the log. If we do this then we going to hit the scaling wall,for example creating 10,000 individual KEDA ScaledObjects for 10,000 tenants would completely overwhelm the Kubernetes etcd control plane. We would be DDoSing our own API server.

If we do this, what will be the operational nightmares. I realized that if the agent writes to Redis asynchronously and then crashes, it might have already sent a message that it hasn't "remembered" yet. we can solved this using an Atomic Outbox Pattern(supposedly) the agent logs a Message Intent to Redis synchronously before calling the Discord API. I also realized that debugging a 90-second delay would be impossible if logs were scattered across Cloudflare, SQS, and KEDA without a shared identity, so we use industry standard way doing it by injecting a Trace-ID at the edge.

Realisticlly we need to think about physical disk limits. until now my idea was 10-second image pull is easy. But standard AWS EBS volumes (gp3) throttle at 125 MiB/s, which would blow our 60s SLA during a mass wake-up. we can cover using node's working set to local NVMe Instance Stores, bypassing the network disk entirely.

## 2. Assumptions & Why
- **Assumption:** Availability < Consistency.
  - **Why:** It is better for an agent to take an extra 5 seconds to wake up than to "hallucinate" because it lost the last two messages of context. We use synchronous Redis writes to ensure state is never a "ghost."
- **Assumption:** OpenClaw is "stateless compute with stateful context."
  - **Why:** We can't move 50GB of RAM snapshots around in under 60 seconds. We strictly decouple the Shared Inference Pool (GPU LLMs) from the Agent Logic (CPU pods).
- **Assumption:** industry standard Multi-tenancy requires Isolation.
  - **Why:** Since agents run untrusted tools, we assume the need for gVisor or Kata Containers to prevent kernel escapes between tenants.


## 3. K8s Mechanics: Wake, Hibernate, and Restore
- **Wake:** KEDA monitors the SQS queue depth. To bypass AWS API rate limits (CreateFleet), we maintain Karpenter Warm Pools (a small buffer of empty, ready nodes).
- **Hibernate:** After 5 minutes of inactivity, KEDA scales the tenant deployment to 0. Since we use Continuous WAL, there is no "save" step needed—the pod simply terminates gracefully.
- **Restore:** The pod pulls its Tenant-ID, queries the Redis Stream, and replays its unacknowledged Outbox intents to reconstruct memory before resuming queue consumption.

## 4. Cold-Start Budget Breakdown

| Phase | Duration | SRE Strategy |
| :--- | :--- | :--- |
| Edge Interception | ~0.1s | Cloudflare Worker immediate 200 OK response. |
| KEDA/Scheduling | 2s | Karpenter Warm Pools bypass EC2 API throttles. |
| Image Provisioning | 8s | Local NVMe Instance Store provides > 1 GB/s throughput, bypassing EBS throttles. |
| Container Init | 2s | Standard containerd execution. |
| State Restoration | 3s | Fetch Snapshot + Replay Redis WAL entries. |
| **Total p99** | **~15s** | Safely under the 60s SLA. |


## 5. SRE operational priorities
As the SRE owning this platform, my operational priorities are:
- **SLIs/SLOs:** Our primary SLO is 95% of cold starts < 30 seconds.
- **Dashboards:** A "Cold Start Heatmap" in Grafana using our custom injected Trace-IDs, showing exactly where latency accumulates across the distributed hops.
- **On-Call:** Alerts trigger if SQS Message Age exceeds 60s (stuck scaler) or if Redis Write Error Rate spikes (preventing state saves).
- **Disaster Recovery (DR):** The Redis WAL is our Source of Truth. We use AWS Global Datastore for Redis to replicate state to a secondary region.


## 6. Cost Projections (Per User/Month)

| Scale | Total Infrastructure | Cost / User / Month | Breakdown |
| :--- | :--- | :--- | :--- |
| 100 Users | ~$350 | $3.50 | High base cost for EKS Control Plane + 1 warm GPU Node. |
| 1,000 Users | ~$3,500 | $3.50 | GPU inference costs scale roughly linearly with active users. |
| 10,000 Users | ~$28,000 | $2.80 | Optimal bin-packing via Karpenter and Spot instance usage. |


## 7. Drawbacks & Gotchas
- **The 429 Poison Pill:** If Discord rate-limits us, the Redis Stream can loop infinitely and crash the pod. Normally for this the way is to use Dead Letter Stream to catch, park, and back-off these messages.
- **NAT Gateway Costs:** At 10,000 users, data transfer for image pulls and API calls will be expensive. We must use VPC Endpoints to keep traffic internal to the AWS backbone.
- **The etcd Object Limit:** Running a 1:1 ratio of Tenant-to-KEDA ScaledObject will eventually generate tens of thousands of API objects. To scale safely beyond 5,000 tenants, we must abandon native KEDA per-tenant objects and write our own custom Kubernetes Operator.


## 8. Appendix: Architecture Diagram
```mermaid
graph TD
    subgraph UserLayer ["User Layer (Edge)"]
        User["User"] --> DiscordWebhook["Discord Webhook"]
        DiscordWebhook --> CFWorker["Cloudflare Worker"]
        CFWorker -- "200 OK (Instant)" --> DiscordWebhook
    end

    subgraph QueueLayer ["Queue Layer (Persistence)"]
        CFWorker --> SQS["AWS SQS"]
    end

    subgraph ControlLayer ["Control Layer (EKS)"]
        KEDA["KEDA (Scale Controller)"]
        Karpenter["Karpenter (Warm Pool)"]
        SQS -. "Metrics" .-> KEDA
        KEDA --> Karpenter
    end

    subgraph ComputeLayer ["Compute Layer (Tenant Isolation)"]
        Node["i4g.large (NVMe Instance Store)"]
        ECR["AWS ECR (SOCI Lazy-Loading)"]
        Pod["OpenClaw Agent Pod"]
        
        Karpenter --> Node
        ECR -- "Seekable OCI" --> Pod
        Node -- "Local I/O" --> Pod
    end

    subgraph StateLayer ["State Layer (Consistency)"]
        Redis["Redis ElastiCache"]
        Pod <--> Redis
        Note1["Synchronous WAL + Outbox Intents"] -.-> Redis
    end

    subgraph InferenceLayer ["Inference Layer (Shared)"]
        GPU["Shared GPU Pool (vLLM)"]
        Pod --> GPU
    end

    subgraph OutputLayer ["Output Layer (Async)"]
        DiscordAPI["Discord API"]
        Pod --> DiscordAPI
        DiscordAPI -- "Async Reply" --> User
    end
```
