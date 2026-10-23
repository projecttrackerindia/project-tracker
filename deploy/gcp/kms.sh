#!/usr/bin/env bash
# Moves the secrets master key (what encrypts every stored token, password vault value and two-step secret) into Google Cloud KMS.
# After this, the server settings hold only the key encrypted by KMS (Mfa__EncryptionKeyWrapped) and the KMS key's name; the VM's service
# account unwraps it at start-up. Nothing stored changes: the same key material is used, so every existing secret still opens.
#
#   ./kms.sh           check what would happen (no changes)
#   ./kms.sh apply     make the change (asks before restarting the API)
#
# Needs: the VM's access scopes to include cloud-platform (or cloudkms). The script checks and stops if they do not.
set -euo pipefail
cd "$(dirname "$0")"
source ./config.sh
MODE=${1:-check}
LOCATION=${KMS_LOCATION:-$REGION}
RING=${KMS_RING:-projecttracker}
KEY=${KMS_KEY:-secrets-master}
KEY_NAME="projects/$PROJECT_ID/locations/$LOCATION/keyRings/$RING/cryptoKeys/$KEY"

SA=$(gcloud compute instances describe "$VM_NAME" --zone="$ZONE" --format='value(serviceAccounts[0].email)')
SCOPES=$(gcloud compute instances describe "$VM_NAME" --zone="$ZONE" --format='value(serviceAccounts[0].scopes)')
echo "VM service account: $SA"
if ! grep -qE 'cloud-platform|cloudkms' <<<"$SCOPES"; then
  echo "The VM's access scopes do not allow Cloud KMS. Stop the VM, add the 'cloud-platform' scope, start it, and run this again." >&2
  exit 1
fi
HAS=$(gcloud compute ssh "$VM_NAME" --zone="$ZONE" --quiet --command='sudo grep -cE "^Mfa__EncryptionKeyWrapped=" /opt/pt/api.env || true' 2>/dev/null | tail -1)
if [ "${HAS:-0}" != "0" ]; then echo "Already using KMS ($KEY_NAME)."; exit 0; fi
OWN=$(gcloud compute ssh "$VM_NAME" --zone="$ZONE" --quiet --command='sudo grep -cE "^Mfa__EncryptionKey=.+" /opt/pt/api.env || true' 2>/dev/null | tail -1)
if [ "${OWN:-0}" = "0" ]; then
  echo "The master key is derived from the JWT signing key (no Mfa__EncryptionKey). Wrapping it would still leave the JWT key in clear," >&2
  echo "so this needs a key rotation first (re-encrypt every secret with a new key). Not done automatically." >&2
  exit 1
fi
echo "Plan: key $KEY_NAME, wrap Mfa__EncryptionKey, replace it in /opt/pt/api.env, restart the API."
[ "$MODE" = apply ] || { echo "(check only: run './kms.sh apply' to make the change)"; exit 0; }

gcloud services enable cloudkms.googleapis.com --quiet
gcloud kms keyrings describe "$RING" --location="$LOCATION" >/dev/null 2>&1 || gcloud kms keyrings create "$RING" --location="$LOCATION"
gcloud kms keys describe "$KEY" --keyring="$RING" --location="$LOCATION" >/dev/null 2>&1 || \
  gcloud kms keys create "$KEY" --keyring="$RING" --location="$LOCATION" --purpose=encryption --rotation-period=365d --next-rotation-time="$(date -u -d '+365 days' +%Y-%m-%dT%H:%M:%SZ)"
gcloud kms keys add-iam-policy-binding "$KEY" --keyring="$RING" --location="$LOCATION" --member="serviceAccount:$SA" --role=roles/cloudkms.cryptoKeyDecrypter >/dev/null

# The key travels only between the VM and KMS over the encrypted ssh/https channels; it is never printed or written to this machine's disk.
WRAPPED=$(gcloud compute ssh "$VM_NAME" --zone="$ZONE" --quiet --command='sudo sed -n "s/^Mfa__EncryptionKey=//p" /opt/pt/api.env | head -1 | tr -d "\n"' 2>/dev/null \
  | gcloud kms encrypt --key="$KEY" --keyring="$RING" --location="$LOCATION" --plaintext-file=- --ciphertext-file=- | base64 -w0)
[ -n "$WRAPPED" ] || { echo "Wrapping failed; nothing changed." >&2; exit 1; }
read -r -p "Replace the clear key on the VM and restart the API now? [y/N] " OK
[ "$OK" = y ] || { echo "Nothing changed on the VM."; exit 0; }
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --quiet --command="set -e; cd /opt/pt; sudo cp api.env api.env.before-kms; sudo chmod 600 api.env.before-kms; \
  sudo sed -i '/^Mfa__EncryptionKey=/d;/^Mfa__EncryptionKeyWrapped=/d;/^Mfa__KmsKeyName=/d' api.env; \
  echo 'Mfa__EncryptionKeyWrapped=$WRAPPED' | sudo tee -a api.env >/dev/null; echo 'Mfa__KmsKeyName=$KEY_NAME' | sudo tee -a api.env >/dev/null; \
  sudo docker compose up -d api && sleep 20 && sudo docker compose ps api"
echo "Done. Check the site; if all is well, remove /opt/pt/api.env.before-kms on the VM (it still holds the clear key)."
