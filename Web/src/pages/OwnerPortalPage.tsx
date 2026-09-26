import { useCallback, useEffect, useMemo, useState } from "react";
import { createDeviceActivation, listStoreDevices, revokeStoreDevice } from "../lib/api";
import { formatDateTime } from "../lib/format";
import {
  getOwnerAccessKey,
  getOwnerStoreId,
  setOwnerAccessKey,
  setOwnerStoreId,
} from "../lib/storage";
import { usePendingAction } from "../lib/usePendingAction";
import type { CreateDeviceActivationResponse, DeviceRecord } from "../types";

type OwnerPortalAction = "create-activation" | "refresh-devices" | "sign-in" | `revoke-device:${string}`;

function hasStoredCredentials(): boolean {
  const id = getOwnerStoreId();
  const key = getOwnerAccessKey();
  return Number.parseInt(id, 10) > 0 && key.trim().length > 0;
}

export function OwnerPortalPage() {
  const [isSignedIn, setIsSignedIn] = useState(hasStoredCredentials);

  // Login form state (only used on the login screen)
  const [loginStoreId, setLoginStoreId] = useState(getOwnerStoreId);
  const [loginAccessKey, setLoginAccessKey] = useState(getOwnerAccessKey);
  const [loginError, setLoginError] = useState("");

  // Dashboard state
  const [deviceName, setDeviceName] = useState("");
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [activation, setActivation] = useState<CreateDeviceActivationResponse | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const { isPending, startAction, finishAction } = usePendingAction<OwnerPortalAction>();

  // Use refs to hold the current auth values so loadDevices can be stable
  const [authStoreId, setAuthStoreId] = useState(() => Number.parseInt(getOwnerStoreId(), 10));
  const [authAccessKey, setAuthAccessKey] = useState(getOwnerAccessKey);

  const activeTablets = useMemo(() => devices.filter((device) => device.status === "active").length, [devices]);

  const loadDevices = useCallback(async (sid: number, key: string) => {
    if (sid <= 0 || key.trim().length === 0) {
      setDevices([]);
      return;
    }
    setErrorMessage("");
    try {
      const response = await listStoreDevices({ storeId: sid, ownerAccessKey: key });
      setDevices(response.devices);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load devices");
    }
  }, []);

  // Load devices on mount if already signed in
  useEffect(() => {
    if (isSignedIn) {
      void loadDevices(authStoreId, authAccessKey);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSignIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsedId = Number.parseInt(loginStoreId, 10);
    if (!Number.isInteger(parsedId) || parsedId <= 0) {
      setLoginError("Enter a valid restaurant ID.");
      return;
    }
    if (loginAccessKey.trim().length === 0) {
      setLoginError("Enter the restaurant access code.");
      return;
    }

    if (!startAction("sign-in")) return;
    setLoginError("");

    try {
      // Validate credentials by attempting to load devices
      await listStoreDevices({ storeId: parsedId, ownerAccessKey: loginAccessKey });
      setOwnerStoreId(loginStoreId);
      setOwnerAccessKey(loginAccessKey);
      setAuthStoreId(parsedId);
      setAuthAccessKey(loginAccessKey);
      setIsSignedIn(true);
      // Refresh full device list now that auth state is updated
      await loadDevices(parsedId, loginAccessKey);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Invalid restaurant ID or access code.");
    } finally {
      finishAction("sign-in");
    }
  }

  function handleSignOut() {
    setOwnerStoreId("");
    setOwnerAccessKey("");
    setLoginStoreId("");
    setLoginAccessKey("");
    setDevices([]);
    setActivation(null);
    setStatusMessage("");
    setErrorMessage("");
    setLoginError("");
    setIsSignedIn(false);
  }

  async function handleRefreshDevices() {
    if (!startAction("refresh-devices")) return;
    try {
      await loadDevices(authStoreId, authAccessKey);
    } finally {
      finishAction("refresh-devices");
    }
  }

  async function handleCreateActivation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!startAction("create-activation")) return;

    setErrorMessage("");
    setStatusMessage("");
    try {
      const result = await createDeviceActivation({
        storeId: authStoreId,
        ownerAccessKey: authAccessKey,
        deviceName,
      });
      setActivation(result);
      setDeviceName("");
      setStatusMessage("Device activation created.");
      await loadDevices(authStoreId, authAccessKey);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to create activation");
    } finally {
      finishAction("create-activation");
    }
  }

  async function handleRevoke(deviceId: string) {
    if (!startAction(`revoke-device:${deviceId}`)) return;

    setErrorMessage("");
    setStatusMessage("");
    try {
      await revokeStoreDevice({ storeId: authStoreId, ownerAccessKey: authAccessKey, deviceId });
      setStatusMessage(`Device ${deviceId} revoked.`);
      await loadDevices(authStoreId, authAccessKey);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to revoke device");
    } finally {
      finishAction(`revoke-device:${deviceId}`);
    }
  }

  // ── Login screen ──────────────────────────────────────────────────────────
  if (!isSignedIn) {
    return (
      <div className="owner-login-wrap">
        <div className="owner-login-card panel stack">
          <div className="owner-login-brand">
            <div className="brand-mark" aria-hidden="true">OO</div>
            <div>
              <p className="eyebrow">OmniOrderAI</p>
              <h2>Restaurant Hub</h2>
            </div>
          </div>

          <p className="owner-login-tagline">
            Sign in to manage devices and set up new service screens.
          </p>

          <form className="stack" onSubmit={(e) => void handleSignIn(e)}>
            <div className="field-group">
              <label htmlFor="login-store-id">Store ID</label>
              <input
                id="login-store-id"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="username"
                value={loginStoreId}
                onChange={(e) => setLoginStoreId(e.target.value)}
                placeholder="e.g. 1"
                required
                autoFocus
              />
              <p className="field-hint">The restaurant number provided during setup.</p>
            </div>

            <div className="field-group">
              <label htmlFor="login-access-code">Restaurant access code</label>
              <input
                id="login-access-code"
                type="password"
                autoComplete="current-password"
                value={loginAccessKey}
                onChange={(e) => setLoginAccessKey(e.target.value)}
                placeholder="Enter access code"
                required
              />
            </div>

            {loginError ? <p className="owner-login-error">{loginError}</p> : null}

            <button
              type="submit"
              className="button primary owner-login-submit"
              disabled={isPending("sign-in")}
            >
              {isPending("sign-in") ? "Signing in…" : "Sign in to Restaurant Hub"}
            </button>
          </form>

          <p className="owner-login-footnote">
            Credentials are stored only in this browser and never sent to a third party.
          </p>
        </div>
      </div>
    );
  }

  // ── Authenticated dashboard ───────────────────────────────────────────────
  return (
    <section className="stack page-section owner-page">
      <div className="owner-portal-header panel">
        <div className="owner-portal-header-left">
          <div className="brand-mark brand-mark-sm" aria-hidden="true">OO</div>
          <div>
            <p className="eyebrow">Restaurant Hub</p>
            <h2>Store&nbsp;#{authStoreId}</h2>
          </div>
          <div className="owner-portal-stats">
            <article className="stat-chip">
              <span className="stat-chip-value">{activeTablets}</span>
              <span className="stat-chip-label">device{activeTablets !== 1 ? "s" : ""} live</span>
            </article>
          </div>
        </div>
        <div className="owner-portal-header-right">
          <button
            type="button"
            className="button ghost owner-refresh-btn"
            onClick={() => void handleRefreshDevices()}
            disabled={isPending("refresh-devices")}
            title="Refresh devices"
          >
            ↺ Refresh
          </button>
          <button
            type="button"
            className="button ghost owner-signout-btn"
            onClick={handleSignOut}
          >
            Sign out
          </button>
        </div>
      </div>

      <section className="owner-main-grid">
        <section className="panel stack owner-activation-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Set up a device</p>
              <h3>Create an activation code</h3>
              <p className="field-hint">This is the main action for daily setup.</p>
            </div>
          </div>

          <form className="stack" onSubmit={(e) => void handleCreateActivation(e)}>
            <div className="field-group">
              <label htmlFor="device-name">Device name</label>
              <input
                id="device-name"
                value={deviceName}
                onChange={(event) => setDeviceName(event.target.value)}
                placeholder="Front counter display"
                required
              />
              <p className="field-hint">Choose a simple name your team will recognize quickly during service.</p>
            </div>

            <div className="button-row">
              <button
                type="submit"
                className="button primary"
                disabled={isPending("create-activation") || deviceName.trim().length === 0}
              >
                Create activation code
              </button>
            </div>
          </form>

          {activation ? (
            <div className="activation-panel owner-activation-result">
              <div>
                <p className="eyebrow">Ready to enter on device</p>
                <div className="activation-code mono">{activation.activationCode}</div>
              </div>
              <div className="stack">
                <p className="field-hint">Use this code before {formatDateTime(activation.expiresAt)}.</p>
                <p className="field-hint">Open the device setup screen, enter the code, and the service board will open automatically.</p>
              </div>
            </div>
          ) : (
            <div className="support-panel owner-activation-empty">
              <p className="field-hint">Create a code when the next device is ready to join service.</p>
            </div>
          )}

          {statusMessage ? <p className="success-text">{statusMessage}</p> : null}
          {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
        </section>

        <section className="panel stack owner-devices-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Connected devices</p>
              <h3>Manage active service screens</h3>
              <p className="field-hint">Remove old or lost devices so only current screens can manage orders.</p>
            </div>
            <span className="status-chip accepted">{activeTablets} live</span>
          </div>

          {devices.length === 0 ? (
            <div className="empty-state">
              <h2>No devices connected yet</h2>
              <p>Create an activation code to bring the first service screen online.</p>
            </div>
          ) : (
            <div className="device-list">
              {devices.map((device) => (
                <article className="device-card" key={device.id}>
                  <div className="device-card-header">
                    <div>
                      <h3>{device.name}</h3>
                      <p className="field-hint mono">{device.id}</p>
                    </div>
                    <span className={`status-chip ${device.status}`}>{device.status === "active" ? "Live" : "Removed"}</span>
                  </div>

                  <div className="meta-list">
                    <span className="meta-pill">Added {formatDateTime(device.createdAt)}</span>
                    <span className="meta-pill">
                      Last active {device.lastSeenAt ? formatDateTime(device.lastSeenAt) : "Not yet seen"}
                    </span>
                  </div>

                  <div className="order-actions">
                    <button
                      type="button"
                      className="button danger"
                      onClick={() => void handleRevoke(device.id)}
                      disabled={isPending(`revoke-device:${device.id}`) || device.status === "revoked"}
                    >
                      Remove device access
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </section>
    </section>
  );
}
