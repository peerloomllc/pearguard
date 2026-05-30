#!/bin/bash
# Custom deb postinst. Replaces electron-builder's generated script so that
# chrome-sandbox is ALWAYS marked SUID (mode 4755).
#
# Why: the stock electron-builder postinst probes user namespaces with
# `unshare --user true` and, if that succeeds, sets chrome-sandbox to 0755
# (relying on the unprivileged-userns sandbox instead of the SUID helper).
# On Ubuntu 23.10+/24.04 the probe is a false positive: the kernel allows
# creating a user namespace (probe passes) but AppArmor's
# `kernel.apparmor_restrict_unprivileged_userns=1` then blocks the Electron
# binary from actually using it. Electron falls back to the SUID sandbox,
# finds chrome-sandbox at 0755 and aborts with:
#   "The SUID sandbox helper binary was found, but is not configured
#    correctly ... owned by root and has mode 4755."
# The SUID helper works on every supported kernel, so we always set 4755.

set -e

if type update-alternatives 2>/dev/null >&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/pearguard' -a -e '/usr/bin/pearguard' -a "`readlink '/usr/bin/pearguard'`" != '/etc/alternatives/pearguard' ]; then
        rm -f '/usr/bin/pearguard'
    fi
    update-alternatives --install '/usr/bin/pearguard' 'pearguard' '/opt/PearGuard/pearguard' 100 || ln -sf '/opt/PearGuard/pearguard' '/usr/bin/pearguard'
else
    ln -sf '/opt/PearGuard/pearguard' '/usr/bin/pearguard'
fi

# Always use the SUID chrome-sandbox helper (works regardless of whether the
# kernel/AppArmor permits the unprivileged user-namespace sandbox).
chown root:root '/opt/PearGuard/chrome-sandbox' || true
chmod 4755 '/opt/PearGuard/chrome-sandbox' || true

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
