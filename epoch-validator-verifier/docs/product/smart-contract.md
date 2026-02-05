# Smart contract: customers and miners

This document describes the smart contract logic for the **wUSDT / GNK** flow with two roles: **customers** and **miners**. Any principal (address) can act as a customer, a miner, or both.

---

## 1. Roles

| Role | Description |
|------|-------------|
| **Customer** | Sends wUSDT to the contract; receives GNK (per epoch) when their request USDT is matched and settled. |
| **Miner** | Registers by paying a fee to get a **gonka address**; can request jobs (with staking) to guarantee revenue, or mine without requesting a job; earns USDT and GNK when jobs complete. |

- Any principal can be **only a customer**, **only a miner**, or **both**.
- Roles are not exclusive: the same address can deposit as a customer and later stake as a miner.

---

## 2. Customer flow

### 2.1 Depositing USDT

- When an address **transfers wUSDT to the contract**, the contract **adds that amount to the customer’s balance**.
- All such amounts are **enqueued** (FIFO), and a **total** is calculated from the queue.

### 2.2 Withdrawing USDT

- A customer can **withdraw USDT** by calling the contract when they have a **positive non-frozen balance**

---

## 3. Miner flow: registration, addresses, and jobs

### 3.1 Registration and gonka addresses (fee-based)

- A miner **gets a gonka address when they want** by **paying a fee** to the contract (e.g. **20 USDT** for the first address).
- When the miner is **registered** (has paid the fee and has at least one address), they **can get jobs** (see §3.2 and §4).
- The miner can **register more addresses** by paying **15 USDT per each new address**.
- Addresses are **not** issued after job matching; they are issued **only on demand** when the miner pays the fee. There is **no time slot** when addresses are withheld—addresses are always available upon payment.

### 3.2 Requesting a job (optional — to guarantee revenue)

- A miner can **request a job** from the contract to **guarantee revenue**. In that case they **stake USDT**. **Only new, uncompleted jobs require a stake**; once a job is completed or resolved (see §5.1), no stake is held for it.
  - **Stake = 20% of the USDT value** of the job they want.
  - Jobs are **measured in USDT**; the job’s **cost** is: **Job cost (USDT) = stake / 0.2**.
- The miner **transfers USDT to the contract with parameters** indicating they want a job of a given size; that creates a **job request** staked into a **FIFO queue**. Only **registered miners** (with at least one address) can request jobs. **Staking is required only when requesting a job.**
- **Optional limit parameter:** A job request can include an optional **limit**. When the limit is set, this job request will match only **jobs** and **completed jobs** whose **price** is **less than** the limit. (Price is the rate at which request USDT is exchanged for GNK; see §4.1.)

### 3.3 Mining without requesting a job

- A miner can **mine without requesting a job** (no staking for that activity). They use one of their registered gonka addresses to mine.
- When the **claim event** and **balance update event** arrive for that address, the contract creates a **completed job** from that mining activity and appends it to the **completed-jobs queue** (see §8). No prior job request or stake is needed.

---

## 4. Matching: requests and jobs

When either **customer requests** (USDT deposits) or **miner job requests** are added, the contract **matches** them.

### 4.1 Price and how matching works

**Price** is the **rate of exchanging USDT from the (customer) request to GNK** — i.e. how much GNK the customer receives per unit of request USDT. It is **calculated after the job completes** (using the epoch’s effective weight→USDT rate and the job’s weight→GNK rate). Until then, when **matching a new job** or considering a **completed job**, the contract uses the **current epoch’s** effective weight→USDT rate and weight→GNK rate to compute an **estimated** (or actual, for completed jobs) price. These rates can change after the next epoch ends.

**Matching rules:**

- **Jobs take from the requests queue** in **FIFO order**.
- A job takes **as much as it needs** from the queue; if the next request in the queue is **larger** than the job needs, only the **needed part** is taken (partial match).
- The contract takes **all possible funds in FIFO order**, and **partial taking** is allowed.
- If the **requests queue** has **less** total than a job needs, the contract still walks the queue in FIFO order and matches **as much as possible** (again with partial matches).
- **When a job request has a limit:** the job request matches only jobs and completed jobs whose (estimated or actual) **price is less than** the limit. For new jobs, price is estimated using the **current epoch’s** effective weight→USDT rate and weight→GNK rate.

### 4.2 After a match

- The **matched request USDT** and the **matched job** are **frozen**:
  - **Request USDT**: moves from **customer balance** to **frozen balance**.
  - **Job**: marked as **claimed** and **leaves the queue**.
- The miner **does not** receive a new address from matching. They must already be **registered** (have paid the fee and have a gonka address) to have had the job matched; they use their existing address for mining and claiming.

---

## 5. Freezing and epoch events

The contract **freezes**:

- **Matched job** (and its stake),
- **Matched request USDT** (moved to frozen balance),
- **Staked miner USDT** (the 20% stake),

until the **epoch ends**. Epoch boundaries and settlement are driven by **events** sent to the contract:

| Event | Scope | Meaning |
|-------|--------|--------|
| **Epoch start** | Global | Epoch begins; includes **list of participants and weights**. Used to set job state (started / non-started) and to return or slash stake (see §5.1). |
| **Epoch end** | Global | Epoch ends; frozen job/request/stake can be settled (see §7). |
| **Claiming** | Per miner / per gonka address | Miner’s address has been used; claim is processed with **effective participant weight**. |
| **Balance update** | Per miner / per gonka address | Balance change for that address; used with claim to compute rate (see §6). |

- If a miner has **several matched jobs**, they all use the **same** gonka address until a claim (and optionally balance update) is processed; nothing special happens for “more matched jobs” except that they remain frozen until settlement.

### 5.1 Job state (started / non-started) and stake return / slashing

Each job has a **started** or **non-started** state. Only **new, uncompleted** jobs require a stake; stake is held until the job is resolved on **epoch start** as below.

**On epoch start**, the contract receives an event with a **listing of all participants and their weights** for that epoch.

- **Participant match:** If there is a **participant address** that matches **one of the job owner's addresses** (the miner's registered gonka addresses), the job is marked **started**. If **no** participant address matches any of the job owner's addresses, the job is treated as **non-started** for stake resolution.
- **Non-started (no matching participant):** The **full stake** for that job is **given to customers** according to their **shares in the job** (the share of request USDT they contributed to the matched amount). The job is then resolved; no stake is returned to the miner.
- **Started, participant weight ≥ 70% of requested weight:** The job is marked started and the **stake is returned to the miner immediately** (full stake).
- **Started, participant weight &lt; 70% of requested weight:** **Half** of the stake is **taken** and **given to customers** according to their **shares in the job**. The **other half** of the stake is **returned to the miner**.

---

## 6. Claim and balance update: effective weight and rate

1. When a **claiming event** arrives for a miner’s gonka address:
   - The corresponding job’s status is set to **claimed**.
   - The job is marked with the **effective participant weight** (provided by the event).

2. When a **balance update event** arrives for that address:
   - The contract computes the **balance difference** (e.g. new balance − previous balance).
   - It computes **rate = effective weight / balance difference**.
   - This **rate is bound to the completed job** and is used later to convert job weight to USDT and to compute GNK share (see §7).

---

## 7. Epoch settlement: exchange rates and queues

### 7.1 Epoch exchange rate (effective weight ↔ USDT)

- For **each epoch** the contract has an **exchange rate**: **effective weight → USDT**.
- The job’s **effective weight** is converted to **USDT** using this **epoch exchange rate**.
- Settlement uses **frozen balances** (frozen request USDT and job stake).

### 7.2 Converting job to USDT and handling over/under weight

- The job is **converted to a USDT amount** using the epoch rate and the job’s effective weight.
- **More weight than needed (over-weight)**  
  - The excess is treated as a **completed job** and is pushed to a **completed-job FIFO queue**.
  - This queue is matched against the **requests queue** (FIFO, with **partial matches** allowed).
  - These matches are **exchanged immediately** (no extra waiting), using the same epoch rate and miner GNK rate as below.

- **Less weight than needed (under-weight)**  
  - The **request USDT** that could not be covered is **returned to the requests queue**, and is placed **first** (so it is matched again as soon as possible).

### 7.3 GNK: epoch rate + miner job rate → customer share

- When request USDT is “exchanged” for job effective weight:
  - The contract uses the **epoch exchange rate** (effective weight ↔ USDT).
  - It then uses the **miner’s job GNK rate** to compute the **share of GNK** that is transferred to the **customer**.
- The **customer’s GNK balance** is **increased** by that share.

### 7.4 USDT to miner

- The **USDT** that was “exchanged” from the request side (i.e. the part that was matched to the job) is moved to the **miner’s balance**.

### 7.5 Customer GNK balance (per epoch)

- Each customer has a **GNK balance** that is **per epoch**.
- Each epoch can have an **individual vesting percent** for that GNK.

---

## 8. Mining without requesting a job (no staking)

- **Each job** (whether from the job-request queue or from over-weight) has its **own GNK balance**.
- A miner can **mine to their gonka address without having requested a job** (no prior job request, **no staking**). Staking is required **only when requesting a job** to guarantee revenue.
- When the **claim event** and **balance update event** arrive for that address:
  - A **completed job** is created from that mining activity.
  - This completed job is appended to the **end of the completed-jobs queue**.
- It is then processed like other completed jobs (matching against requests, GNK/USDT settlement as in §7).

---

## 9. Summary of queues and balances

| Concept | Description |
|--------|-------------|
| **Requests queue** | FIFO queue of customer USDT deposits (request amounts). Can be partially consumed by jobs. |
| **Job requests queue** | FIFO queue of miner job requests (each with stake = 20% of job cost; cost = stake/0.2). Only registered miners can add. Optional **limit**: match only jobs/completed jobs whose price &lt; limit. |
| **Price** | Rate of exchanging request USDT → GNK; calculated after job completes. For matching new jobs, estimated using current epoch’s weight→USDT and weight→GNK rates (can change next epoch). |
| **Completed jobs queue** | FIFO queue of completed jobs (from over-weight or from mining without a job request). Matched against requests (FIFO, partial allowed); USDT → miner, GNK → customer. |
| **Customer balance** | Available and frozen USDT; withdrawable when not frozen. |
| **Customer GNK balance** | Per-epoch GNK balance; vesting % per epoch. |
| **Miner balance** | USDT received from settled jobs. |
| **Job GNK balance** | Per-job GNK; used with miner’s job GNK rate to compute customer GNK share. |
| **Frozen** | Request USDT, job stake, and matched job frozen until epoch end and settlement. |
| **Job state** | **Started** / **non-started**; set on epoch start from participant list. Only new uncompleted jobs need a stake; stake resolved on epoch start: non-started → full stake to customers (by share); started and weight ≥70% → full stake to miner; started and weight &lt;70% → half stake to customers (by share), half to miner. |
| **Registration fee** | 20 USDT for first gonka address (register as miner); 15 USDT per each additional address. |

---

## 10. Event summary

| Event | When | Effect (high level) |
|-------|------|----------------------|
| **Epoch start** | Start of epoch | Epoch begins; participant list + weights → job state (started/non-started); stake returned to miner or slashed to customers (see §5.1). |
| **Epoch end** | End of epoch | Enables settlement: epoch rate applied, jobs converted to USDT, over-weight → completed queue, under-weight request USDT back to queue; GNK and USDT distributed. |
| **Claiming** | Per miner/address | Job marked claimed; effective participant weight stored; used with balance update for rate. |
| **Balance update** | Per miner/address | Balance diff computed; rate = effective weight / balance diff bound to job; used in settlement. For mining without a job request, triggers creation of completed job → completed-jobs queue. |
