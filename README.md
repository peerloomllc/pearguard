# 🍐🛡️ PearGuard

**A privacy-focused, peer-to-peer parental control app. Child device on Android; parent device on Android or iOS.**

PearGuard lets a parent device manage screen time and app access on a child device directly - no accounts, no servers, no subscriptions. Your family's data lives only on the devices you pair.

---

## Features

- **Screen time limits** - set daily time budgets and bedtime windows on the child device
- **Per-app policies** - allow, block or time-limit individual apps
- **Activity view** - see what's been used and when, directly from the parent device
- **Time requests** - child can request extra time; parent approves or denies from their device
- **Fully offline-first** - policies apply immediately on the child device; syncs whenever devices can reach each other
- **No accounts** - identity is a cryptographic key pair generated on your device; nothing is tied to an email or phone number
- **No data collection** - PeerLoom, Google and no third party ever sees your family's activity

---

## How It Works

PearGuard uses **peer-to-peer technology** powered by [Hypercore Protocol](https://hypercore-protocol.org) to sync policies and activity directly between parent and child devices.

### No servers
Most parental control apps route your child's activity through a central server. The app company can read your data, sell it, get hacked, go down or shut down. PearGuard has no central server. Your family's data never leaves your devices.

### How sync works
When the parent and child devices are online at the same time - whether on the same Wi-Fi network or anywhere on the internet - they find each other using a distributed hash table (DHT), a technology similar to how BitTorrent works. Once connected, they sync directly, device to device, with no middleman.

### Encrypted and signed
All data is encrypted in transit and every policy update is cryptographically signed by the parent device. The child device only applies policies it can verify came from a paired parent.

### Enforcement
On the child device, PearGuard uses Android's Accessibility Service and Device Admin APIs to enforce app blocks, time limits and bedtime windows. These are standard Android parental-control surfaces - the child cannot disable them without the parent's approval.

### Pairing
Parent and child pair via a one-time invite link or QR code. The link encodes the cryptographic address of the pairing - there's no server involved. After pairing, both devices remember each other; the invite link is single-use.

---

## Privacy

- No accounts or sign-up required
- No analytics, tracking or telemetry
- No third-party SDKs
- All sync traffic is encrypted end-to-end
- Activity data stays on the parent and child devices - never uploaded anywhere

---

## Known Limitations

- **Child device must be Android** - iOS does not expose the enforcement APIs required (Accessibility Service, Device Admin). The parent device can run Android or iOS.
- **Both devices must be online simultaneously** to sync policy changes or activity in real time - changes made offline sync the next time devices connect

---

## Feedback & Bug Reports

Please open an [issue](../../issues) on GitHub. Include your Android version and a description of what happened.
