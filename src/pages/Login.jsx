import React, { useState } from 'react';
import api, { auth } from '../lib/api';

export default function Login({ onSignedIn, reason }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(reason || '');

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { token, user } = await api.login(email.trim(), password, remember);
      auth.setToken(token);
      onSignedIn(user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="card stack" onSubmit={submit}>
        <div>
          <img src="/favicon.svg" alt="" width="40" height="40" />
          <h1>Customer Connect</h1>
          <div className="light">Sign in to send campaigns to your customers.</div>
        </div>
        <label className="field"><span>Email</span>
          <input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <label className="field"><span>Password</span>
          <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span>Keep me signed in for 30 days</span>
        </label>
        {error && <div className="error" role="alert">{error}</div>}
        <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
