# Move app icons out of the parent's policy record

**Goal** - Keep app icons in their own keys on the parent, so the routine readers of a child's policy stop parsing every icon on every read.

**Tier** - T2. It adds a Hyperbee key family (`icon:{child}:{pkg}`) and changes what `policy:{child}` holds on the parent. The wire format does not change.

## Today

#242 keeps icons off the wire and off the child. The parent still keeps them inside `policy:{child}.apps[pkg].iconBase64`, so these readers parse every icon on each read:

- the heartbeat handler, every 60 s per child (`bare.js` ~994, ~1018)
- `children:list` (`bare-dispatch.js` ~464)
- the usage category summary (`bare-dispatch.js` ~2086)

So do every policy write and `backup:export`.

## Scope

1. **New key** `icon:{childPublicKey}:{packageName}` holds the base64 string. There are three helpers in `bare-dispatch.js`:
   - `putAppIcon` writes one icon
   - `getAppIcon` reads one
   - `getAppIcons` reads every icon for a child in one range read and returns `{ pkg: base64 }`
2. **Writers move to the new key:**
   - `handleIncomingAppInstalled` and `handleIncomingAppsSync` store the icon under `icon:` and no longer put it in the policy. Apps sync only writes an icon that is missing, as today.
   - `policy:update` strips icons from the object the Apps tab sends back. Any icon it carries is written to `icon:` first, so none is lost.
   - The co-parent relay merge in `bare.js` (~820-828) goes away, because the stored policy no longer carries icons.
3. **Readers:**
   - `policy:get` merges icons back in with one `getAppIcons` read, so the Apps tab and its tests see the same shape as today.
   - The heartbeat and `children:list` use `getAppIcon` for the current app only.
   - The usage summary uses `getAppIcons`.
4. **Cleanup.** Child removal (`bare-dispatch.js` ~546) and child-initiated leave (`bare.js` ~777) also delete `icon:{child}:*`.
5. **Migration.** At parent startup, each `policy:{child}` that still holds icons has them moved to `icon:` keys under `withPolicyLock`, and is written back without them. The same helper runs on `backup:import`, so an old backup with icons still restores them. The step does nothing once a policy holds no icons, so a second run is safe.

Unchanged:

- the P2P messages: `app:installed` and `apps:sync` still carry icons from the child, and `policy:update` was already stripped
- the child, which never stores icons
- `rules:export`, which already strips them

## Compat

Only the parent's own storage changes, so peers see no difference. Co-parents each keep their own icons, as today.

A new `backup:export` no longer contains icons, so a parent restored from a new backup shows letter placeholders until the child's next `apps:sync` sends them again. An old backup that does contain icons is migrated on import.

## Verify

- Jest:
  - `app:installed` and `apps:sync` write `icon:` keys and keep icons out of `policy:`
  - `policy:get` returns the icons merged in
  - `policy:update` with icons stores them under `icon:` and saves the policy without them
  - The startup migration moves icons out and does nothing on a second run
  - Removing a child deletes its icons
  - The heartbeat, `children:list` and the usage summary still return icons
- `npm run verify`.
- `npm run test:harness` pairing and apps-sync scenarios.
- On the parent phone (the Pixel, observe-only): after install, the Apps tab and Dashboard still show icons. A forensic pull of the parent's Hyperbee shows no `iconBase64` left inside any `policy:` value.

## Rollback

Revert the PR. Old code reads icons only from the policy, so icons show as placeholders until the child's next `apps:sync` fills them back in. The leftover `icon:` keys are unread and harmless.

## Open questions

None.
