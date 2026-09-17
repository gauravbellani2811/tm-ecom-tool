import React, { useState } from "react";
import Brand from "./Brand";

export default function Login({ onLogin }) {
  const [name, setName] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    const username = name.trim();
    if (!username) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Login failed"); return; }
      onLogin(data.user, data.role);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <Brand variant="login" />
        <p className="login-sub">Ecom Tool · enter your username to continue</p>
        <input
          className="login-input"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="username"
          autoFocus
          autoComplete="username"
        />
        {error && <div className="login-error">{error}</div>}
        <button className="btn btn-primary login-btn" type="submit" disabled={busy}>
          {busy ? "Checking…" : "Enter"}
        </button>
        <p className="login-note">
          This is an identity check for the team, not a password. Ask the admin if your username isn't recognised.
        </p>
      </form>
    </div>
  );
}
