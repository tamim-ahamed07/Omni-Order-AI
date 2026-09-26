import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { activateDevice } from "../lib/api";
import { usePendingAction } from "../lib/usePendingAction";
import { setDeviceToken } from "../lib/storage";

export function DeviceActivationPage() {
  const [activationCode, setActivationCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const { isPending, startAction, finishAction } = usePendingAction<"activate">();
  const navigate = useNavigate();

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!startAction("activate")) {
      return;
    }

    setLoading(true);
    setErrorMessage("");

    try {
      const result = await activateDevice(activationCode.trim().toUpperCase());
      setDeviceToken(result.deviceToken);
      navigate("/device/dashboard", { replace: true });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to activate device");
    } finally {
      setLoading(false);
      finishAction("activate");
    }
  }

  return (
    <section className="activation-layout">
      <section className="hero-panel">
        <p className="eyebrow">Device setup</p>
        <h2>Connect this device for live service</h2>
        <p className="hero-copy">
          Enter the setup code from the restaurant hub. Once connected, this device opens the order board and stays
          ready for service.
        </p>

        <div className="support-list">
          <article className="support-panel">
            <h3>1. Create a code</h3>
            <p className="field-hint">Generate a short-lived setup code in the restaurant hub.</p>
          </article>
          <article className="support-panel">
            <h3>2. Enter it here</h3>
            <p className="field-hint">Type the code on the device you want to place on the floor or at the counter.</p>
          </article>
          <article className="support-panel">
            <h3>3. Start service</h3>
            <p className="field-hint">The board opens automatically and keeps this device signed in for daily use.</p>
          </article>
        </div>
      </section>

      <section className="panel stack activation-form-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Enter code</p>
            <h3>Finish device setup</h3>
          </div>
          <span className="support-pill">Mobile friendly</span>
        </div>

        <form className="stack" onSubmit={handleSubmit}>
          <div className="field-group">
            <label htmlFor="activation-code">Setup code</label>
            <input
              id="activation-code"
              value={activationCode}
              onChange={(event) => setActivationCode(event.target.value.toUpperCase())}
              placeholder="ABC123EF90"
              className="mono"
              required
            />
            <p className="field-hint">Use the code exactly as shown in the restaurant hub.</p>
          </div>

          <div className="button-row">
            <button
              type="submit"
              className="button primary"
              disabled={loading || isPending("activate") || activationCode.trim().length < 6}
            >
              {loading ? "Connecting device..." : "Connect device"}
            </button>
          </div>
        </form>

        {errorMessage ? <p className="error-text">{errorMessage}</p> : null}

        <div className="support-panel">
          <p className="field-hint">If the code does not work, create a new one in the restaurant hub and try again.</p>
        </div>
      </section>
    </section>
  );
}
