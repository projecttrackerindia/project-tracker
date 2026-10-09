import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError, apiUrl } from '../../api/client';
import type { ExternalProvider } from '../../api/types';
import { authApi, consentApi, passkeyApi, workspaceApi } from '../../api/endpoints';
import { passkeysSupported, requestPasskey, wasCancelled } from '../../lib/passkeys';
import { Field, Modal, PageLoader, PasswordInput, SubmitButton, applyServerErrors } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { AuthLayout } from '../../layouts/AuthLayout';
import { useAuth } from '../../stores/auth';
import { usePageTitle } from '../../lib/title';
import { celebrate, firstName, originOf, useCelebration, type CelebrationKind } from '../../stores/celebrate';
import { toast } from '../../stores/ui';
import { PhoneStep } from './PhoneSignIn';
import { AuthSubmitButton, FloatingField, PasswordField, useShake } from './AuthFields';
import { PasswordChecklist, passwordProblem, usePasswordPolicy } from './passwordPolicy';
import { safeRedirect } from './redirect';

/** Purely a convenience: the last email that was signed in with "Remember me" checked, refilled on this device only. */
const REMEMBERED_EMAIL_KEY = 'pm_remembered_email';
const rememberedEmail = () => { try { return localStorage.getItem(REMEMBERED_EMAIL_KEY) ?? ''; } catch { return ''; } };

/**
 * A password field checked against the platform's current policy. The policy is read through a ref so the schema stays stable
 * while the policy loads; the server checks it again (and also refuses common or personal passwords).
 */
function usePolicyPassword() {
  const policy = usePasswordPolicy();
  const ref = useRef(policy);
  ref.current = policy;
  const field = useMemo(() => z.string().min(1, 'Enter a password.').superRefine((pw, ctx) => {
    const problem = passwordProblem(ref.current, pw);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  }), []);
  return { policy, field };
}

/** The mark of each outside sign-in option. */
export const PROVIDER_ICON: Record<ExternalProvider['id'], ReactNode> = {
  google: (<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
          </svg>),
  microsoft: (<svg viewBox="0 0 23 23" width="17" height="17" aria-hidden="true"><path fill="#f35325" d="M1 1h10v10H1z" /><path fill="#81bc06" d="M12 1h10v10H12z" /><path fill="#05a6f0" d="M1 12h10v10H1z" /><path fill="#ffba08" d="M12 12h10v10H12z" /></svg>),
  github: (<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
            <path d="M12 .5A11.5 11.5 0 0 0 .5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.2 1.77 1.2 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.12 3.05.74.81 1.18 1.84 1.18 3.1 0 4.43-2.69 5.4-5.25 5.69.41.36.78 1.06.78 2.14v3.17c0 .31.2.67.8.56A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5Z" />
          </svg>),
  apple: (<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
            <path d="M16.36 12.72c-.02-2.3 1.88-3.4 1.96-3.46-1.07-1.56-2.73-1.78-3.32-1.8-1.41-.14-2.76.83-3.48.83-.72 0-1.83-.81-3.01-.79-1.55.02-2.98.9-3.78 2.29-1.61 2.79-.41 6.93 1.16 9.2.77 1.11 1.68 2.36 2.88 2.31 1.16-.05 1.6-.75 3-.75s1.79.75 3.01.73c1.24-.02 2.03-1.13 2.79-2.25.88-1.29 1.24-2.54 1.26-2.6-.03-.01-2.42-.93-2.44-3.68l-.03-.03ZM14.1 5.4c.64-.77 1.07-1.85.95-2.92-.92.04-2.03.61-2.69 1.38-.59.68-1.11 1.78-.97 2.83 1.03.08 2.07-.52 2.71-1.29Z" />
          </svg>),
};

/**
 * Outside sign-in: the Google / Microsoft / GitHub / Apple options this installation has set up (none are shown until their settings are
 * in place), and "Sign in with SSO" for organizations with their own identity provider. Each one sends the browser away to sign in and
 * back through /auth/complete.
 */
function SocialButtons({ redirect, email, onSso }: { redirect: string; email: string; onSso: () => void }) {
  const q = useQuery({ queryKey: ['auth', 'providers'], queryFn: authApi.providers, staleTime: 5 * 60_000, retry: false });
  const providers = q.data?.providers ?? [];
  const go = (id: string) => window.location.assign(apiUrl(`/auth/external/${id}/start?returnUrl=${encodeURIComponent(redirect)}`));
  return (
    <>
      <div className="auth-divider">or continue with</div>
      <div className={`auth-socials ${providers.length + 1 >= 4 ? 'four' : ''}`}>
        {providers.map((p) => (
          <button key={p.id} type="button" className="auth-social" onClick={() => go(p.id)} aria-label={`Continue with ${p.name}`}>
            {PROVIDER_ICON[p.id]}<span>{p.name}</span>
          </button>
        ))}
        <button type="button" className="auth-social sso" onClick={onSso} aria-label="Sign in with single sign-on" title={email ? `Single sign-on for ${email}` : 'Your organization\'s single sign-on'}>
          <Icon name="building" size={17} /><span>SSO</span>
        </button>
      </div>
    </>
  );
}

/** Single sign-on: the work email decides which organization's identity provider to use. */
function SsoStep({ email: initial, redirect, onBack }: { email: string; redirect: string; onBack: () => void }) {
  const [email, setEmail] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) { setError('Enter your work email address.'); return; }
    setBusy(true); setError(null);
    try {
      const d = await authApi.ssoDiscover(email.trim());
      if (!d.sso) { setError(`Single sign-on is not set up for ${email.trim().split('@')[1]}. Sign in with your password instead.`); setBusy(false); return; }
      window.location.assign(apiUrl(`/auth/sso/start?email=${encodeURIComponent(email.trim())}&returnUrl=${encodeURIComponent(redirect)}`));
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not check single sign-on. Please try again.'); setBusy(false); }
  };
  return (
    <AuthLayout title="Single sign-on" sub="Sign in with your organization's identity provider (Microsoft Entra ID, Okta, Google Workspace ...)."
      footer={<button type="button" className="link" onClick={onBack}>Back to sign in with a password</button>}>
      <form className="auth-form" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
        {error && <div className="form-error" role="alert">{error}</div>}
        <FloatingField id="sso-email" icon="mail" label="Work email" type="email" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
        <AuthSubmitButton busy={busy}>Continue with SSO<Icon name="arrowRight" /></AuthSubmitButton>
      </form>
    </AuthLayout>
  );
}

/**
 * Where a redirect sign-in lands (single sign-on, Google ...): the session cookie is already set, so the app's start-up refresh signs the
 * person in; this page then plays the success moment and goes on to where they were headed.
 */
export function AuthCompletePage() {
  const status = useAuth((s) => s.status);
  const [params] = useSearchParams();
  const nav = useNavigate();
  const to = safeRedirect(params.get('to'));
  const started = useRef(false);
  useEffect(() => {
    if (started.current || status === 'loading') return;
    started.current = true;
    if (status !== 'authenticated') { nav('/login?sso_error=SSO_FAILED&message=' + encodeURIComponent('The sign-in could not be completed. Please try again.'), { replace: true }); return; }
    const ctx = useAuth.getState().ctx;
    const ws = ctx?.current;
    celebrate({ kind: 'signin', name: firstName(ctx?.user.displayName), detail: ws ? (ws.type === 'Personal' ? 'your personal workspace' : ws.name) : undefined, onHandoff: () => nav(to, { replace: true }) });
  }, [status, nav, to]);
  return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}><PageLoader /></div>;
}

function DevHint() {
  if (!import.meta.env.DEV) return null;
  return (
    <div className="demo-hint">
      <b>Development mode</b><br />
      Demo owner: <code>demo@example.com</code> / <code>Demo@12345</code><br />
      Platform admin: <code>admin@example.com</code> / <code>Admin@12345</code><br />
      Verification and reset emails appear in the <Link className="link" to="/dev/mailbox">dev mailbox</Link>.
    </div>
  );
}

// ------------------------------------------------------------------ login
const loginSchema = z.object({ email: z.string().min(1, 'Enter your email.').email('Enter a valid email.'), password: z.string().min(1, 'Enter your password.') });

export function LoginPage() {
  usePageTitle('Sign in');
  const status = useAuth((s) => s.status);
  const login = useAuth((s) => s.login);
  const loginMfa = useAuth((s) => s.loginMfa);
  const [params, setParams] = useSearchParams();
  // A redirect sign-in that needs the second step (Google ... for someone with two-step verification) comes back with its challenge.
  const [challenge, setChallenge] = useState<string | null>(() => params.get('mfa_challenge'));
  const [code, setCode] = useState('');
  const nav = useNavigate();
  const [error, setError] = useState<string | null>(() => params.get('sso_error') ? params.get('message') ?? 'Sign-in could not be completed.' : null);
  const [sso, setSso] = useState(false);
  const [phoneEmail, setPhoneEmail] = useState<string | null>(null);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [unverified, setUnverified] = useState(false);
  const [remember, setRemember] = useState(() => !!rememberedEmail());
  const [shaking, shake] = useShake();
  /**
   * True from the moment a sign-in is submitted until it fails. `login()` marks the session authenticated *inside* its
   * own promise, before onSuccess runs, and that re-renders this page first; without this flag the redirect guard below
   * would fire on that render and navigate away before the success moment ever started.
   */
  const [signingIn, setSigningIn] = useState(false);
  const celebrating = useCelebration((s) => s.current !== null);
  const { register, handleSubmit, getValues, formState: { errors } } = useForm<z.infer<typeof loginSchema>>({
    resolver: zodResolver(loginSchema), defaultValues: { email: rememberedEmail(), password: '' },
  });
  const redirect = safeRedirect(params.get('redirect') ?? params.get('to'));
  // The hand-off parameters are read once; keep them out of the address bar (and out of a reload).
  useEffect(() => {
    if (!params.has('sso_error') && !params.has('mfa_challenge')) return;
    const n = new URLSearchParams(params); ['sso_error', 'message', 'mfa_challenge', 'via'].forEach((k) => n.delete(k));
    setParams(n, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Hands off to the full-screen success moment, which navigates into the app while it still covers the screen. */
  const enterApp = (kind: CelebrationKind) => {
    const ctx = useAuth.getState().ctx;
    const ws = ctx?.current;
    celebrate({
      kind,
      name: firstName(ctx?.user.displayName),
      detail: ws ? (ws.type === 'Personal' ? 'your personal workspace' : ws.name) : undefined,
      origin: originOf('.auth-submit'),
      onHandoff: () => nav(redirect, { replace: true }),
    });
  };

  /** The device's own prompt (fingerprint, face or screen lock) instead of a password; with an email typed, that account's passkeys are offered first. */
  const signInWithPasskey = async () => {
    setError(null); setPasskeyBusy(true);
    try {
      const { challengeId, options } = await passkeyApi.signInOptions(getValues('email').trim());
      const response = await requestPasskey(options);
      setSigningIn(true);
      const auth = await passkeyApi.signIn(challengeId, response);
      await useAuth.getState().completeSession(auth);
      enterApp('signin');
    } catch (e) {
      setSigningIn(false);
      if (!wasCancelled(e)) { setError(e instanceof ApiError ? e.message : 'Could not sign in with a passkey. Try your password.'); shake(); }
    } finally { setPasskeyBusy(false); }
  };

  const m = useMutation({
    mutationFn: (v: z.infer<typeof loginSchema>) => login(v.email, v.password),
    onSuccess: (r, v) => {
      try { if (remember) localStorage.setItem(REMEMBERED_EMAIL_KEY, v.email); else localStorage.removeItem(REMEMBERED_EMAIL_KEY); } catch { /* storage unavailable */ }
      if (r.mfaChallenge) { setSigningIn(false); setChallenge(r.mfaChallenge); setCode(''); return; }
      enterApp('signin');
    },
    onError: (e, v) => {
      // The organization requires its own single sign-on for this address: go there instead of showing an error.
      if (e instanceof ApiError && e.code === 'SSO_REQUIRED') {
        toast('Your organization signs you in through its single sign-on. Taking you there…', 'info');
        window.location.assign(apiUrl(`/auth/sso/start?email=${encodeURIComponent(v.email)}&returnUrl=${encodeURIComponent(redirect)}`));
        return;
      }
      setSigningIn(false);
      setUnverified(e instanceof ApiError && e.code === 'EMAIL_NOT_VERIFIED');
      setError(e instanceof ApiError ? e.message : 'Could not sign in. Please try again.');
      shake();
    },
  });
  const verify = useMutation({
    mutationFn: () => loginMfa(challenge!, code),
    onSuccess: () => enterApp('verified'),
    onError: (e) => {
      setSigningIn(false);
      if (e instanceof ApiError && e.code === 'MFA_CHALLENGE_INVALID') { setChallenge(null); setError(e.message); return; }
      setError(e instanceof ApiError ? e.message : 'Could not verify the code. Please try again.');
      shake();
    },
  });
  const resend = useMutation({ mutationFn: () => authApi.resendVerification(getValues('email'), redirect), onSuccess: () => toast('Verification email sent (if the account exists).', 'info') });

  if (status === 'authenticated' && !signingIn && !celebrating) return <Navigate to={redirect} replace />;
  if (phoneEmail) return <PhoneStep email={phoneEmail} onBack={() => setPhoneEmail(null)}
    onApproved={(auth) => { setSigningIn(true); void useAuth.getState().completeSession(auth).then(() => enterApp('signin')); }} />;
  if (sso) return <SsoStep email={getValues('email')} redirect={redirect} onBack={() => setSso(false)} />;
  if (challenge) return (
    <AuthLayout title="Two-step verification" sub="Enter the 6-digit code from your authenticator app, or one of your recovery codes." shake={shaking}
      footer={<button type="button" className="link" onClick={() => { setChallenge(null); setError(null); }}>Back to sign in</button>}>
      <form className="auth-form" onSubmit={(e) => { e.preventDefault(); setError(null); if (code.trim()) { setSigningIn(true); verify.mutate(); } else shake(); }} noValidate>
        {error && <div className="form-error" role="alert">{error}</div>}
        <FloatingField id="mfa-code" icon="shield" label="Verification code" autoComplete="one-time-code" inputMode="text" autoFocus
          value={code} onChange={(e) => setCode(e.target.value)} />
        <AuthSubmitButton busy={verify.isPending}>Verify and sign in<Icon name="arrowRight" /></AuthSubmitButton>
      </form>
    </AuthLayout>
  );
  return (
    <AuthLayout title="Welcome back" sub="Sign in to continue to your workspace." shake={shaking}
      footer={<>New here? <Link className="link" to={`/register${redirect !== '/' ? `?redirect=${encodeURIComponent(redirect)}` : ''}`}>Create an account</Link>
        <span className="auth-foot-sep">·</span><a className="link" href="/security/">Security</a></>}>
      <form className="auth-form" onSubmit={handleSubmit((v) => { setError(null); setSigningIn(true); m.mutate(v); }, () => shake())} noValidate>
        {error && <div className="form-error" role="alert">{error}{unverified && <> <button type="button" className="link" onClick={() => resend.mutate()}>Resend verification email</button></>}</div>}
        <FloatingField id="email" icon="mail" label="Email address" type="email" autoComplete="email" autoFocus error={errors.email?.message} {...register('email')} />
        <PasswordField id="password" label="Password" autoComplete="current-password" error={errors.password?.message} {...register('password')} />
        <div className="auth-row">
          <label className="auth-remember"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />Remember me</label>
          <Link className="link" to="/forgot-password" style={{ fontSize: 13.5 }}>Forgot password?</Link>
        </div>
        <AuthSubmitButton busy={m.isPending}>Sign in<Icon name="arrowRight" /></AuthSubmitButton>
        <div className={`auth-alts ${passkeysSupported() ? 'two' : ''}`}>
          {passkeysSupported() && <button type="button" className="auth-alt auth-passkey" disabled={passkeyBusy} onClick={() => void signInWithPasskey()}><Icon name="key" size={18} />Passkey</button>}
          <button type="button" className="auth-alt auth-phone" onClick={() => {
            const e = getValues('email').trim();
            if (!z.string().email().safeParse(e).success) { setError('Enter your email above, then choose your phone.'); shake(); return; }
            setError(null); setPhoneEmail(e);
          }}><Icon name="bell" size={18} />Phone</button>
        </div>
        <SocialButtons redirect={redirect} email={getValues('email')} onSso={() => { setError(null); setSso(true); }} />
      </form>
      <DevHint />
    </AuthLayout>
  );
}

// ------------------------------------------------------------------ register
type RegisterValues = { displayName: string; email: string; password: string; confirm: string; acceptedTerms: boolean };

/** The Terms of Service and Privacy Policy text, read on demand so the sign-up form doesn't need to fetch it up front. */
function LegalDocsModal({ onClose }: { onClose: () => void }) {
  const q = useQuery({ queryKey: ['consent', 'documents'], queryFn: consentApi.documents });
  return (
    <Modal size="lg" title="Terms of Service & Privacy Policy" onClose={onClose} footer={<button type="button" className="btn btn-primary" onClick={onClose}>Close</button>}>
      {q.isLoading ? <PageLoader /> : q.data?.map((d) => (
        <div key={d.type} style={{ marginBottom: 20 }}>
          <h4 style={{ marginBottom: 6 }}>{d.title}</h4>
          <p className="muted" style={{ whiteSpace: 'pre-wrap' }}>{d.body}</p>
        </div>
      ))}
    </Modal>
  );
}

export function RegisterPage() {
  usePageTitle('Create your account');
  const status = useAuth((s) => s.status);
  const [params] = useSearchParams();
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showLegal, setShowLegal] = useState(false);
  const redirect = safeRedirect(params.get('redirect'));
  const { policy, field: passwordField } = usePolicyPassword();
  const registerSchema = useMemo(() => z.object({
    displayName: z.string().trim().min(1, 'Enter your name.').max(100),
    email: z.string().min(1, 'Enter your email.').email('Enter a valid email.'),
    password: passwordField,
    confirm: z.string(),
    acceptedTerms: z.boolean().refine((v) => v, { message: 'You must accept the Terms of Service and Privacy Policy.' }),
  }).refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords do not match.' }), [passwordField]);
  const { register, handleSubmit, watch, setError: setFieldError, formState: { errors } } = useForm<RegisterValues>({
    resolver: zodResolver(registerSchema), defaultValues: { email: params.get('email') ?? '', acceptedTerms: false },
  });
  const typed = watch('password') ?? '';

  const m = useMutation({
    mutationFn: (v: RegisterValues) => authApi.register({ email: v.email, password: v.password, displayName: v.displayName, acceptedTerms: v.acceptedTerms, returnUrl: redirect }),
    // The "check your email" step is swapped in underneath the success moment, which then lifts to reveal it.
    onSuccess: (_r, v) => celebrate({
      kind: 'register', name: firstName(v.displayName), detail: v.email,
      origin: originOf('.auth-card button[type="submit"]'), onHandoff: () => setDone(v.email),
    }),
    onError: (e) => setError(applyServerErrors(e, setFieldError, ['email', 'password', 'displayName'])),
  });

  if (status === 'authenticated') return <Navigate to={redirect} replace />;
  if (done) return (
    <AuthLayout title="Check your email" sub={`We sent a verification link to ${done}. Open it to activate your account, then sign in.`}
      footer={<Link className="link" to={`/login${redirect !== '/' ? `?redirect=${encodeURIComponent(redirect)}` : ''}`}>Go to sign in</Link>}>
      <div className="auth-mail-hero" aria-hidden="true">
        <span className="amh-wave" /><span className="amh-wave amh-wave-2" />
        <span className="amh-icon"><Icon name="mail" size={26} /></span>
      </div>
      <div className="form-info"><Icon name="mail" size={14} /> The link expires in 24 hours.</div>
      <DevHint />
    </AuthLayout>
  );
  return (
    <AuthLayout title="Create your account" sub="Start with a free personal workspace. Create or join an organization anytime."
      footer={<>Already have an account? <Link className="link" to={`/login${redirect !== '/' ? `?redirect=${encodeURIComponent(redirect)}` : ''}`}>Sign in</Link></>}>
      <form className="auth-form" onSubmit={handleSubmit((v) => { setError(null); m.mutate(v); })} noValidate>
        {error && <div className="form-error" role="alert">{error}</div>}
        <Field label="Full name" error={errors.displayName?.message}><input className="input" autoComplete="name" autoFocus {...register('displayName')} /></Field>
        <Field label="Email" error={errors.email?.message}><input className="input" type="email" autoComplete="email" {...register('email')} /></Field>
        <Field label="Password" error={errors.password?.message}><PasswordInput autoComplete="new-password" {...register('password')} /></Field>
        <PasswordChecklist policy={policy} password={typed} />
        <Field label="Confirm password" error={errors.confirm?.message}><PasswordInput autoComplete="new-password" {...register('confirm')} /></Field>
        <label className="auth-remember" style={{ alignItems: 'flex-start', marginTop: 2 }}>
          <input type="checkbox" {...register('acceptedTerms')} />
          <span>I agree to the <button type="button" className="link" onClick={() => setShowLegal(true)}>Terms of Service and Privacy Policy</button></span>
        </label>
        {errors.acceptedTerms && <div className="form-error" role="alert">{errors.acceptedTerms.message}</div>}
        <SubmitButton busy={m.isPending}>Create account</SubmitButton>
      </form>
      {showLegal && <LegalDocsModal onClose={() => setShowLegal(false)} />}
    </AuthLayout>
  );
}

// ------------------------------------------------------------------ verify email
export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const redirect = safeRedirect(params.get('redirect'));
  const [state, setState] = useState<'working' | 'ok' | 'error'>(token ? 'working' : 'error');
  const [message, setMessage] = useState('This verification link is invalid.');
  const ran = useRef(false);

  useEffect(() => {
    if (!token || ran.current) return; // guard against React StrictMode running the effect twice (links are single-use)
    ran.current = true;
    authApi.verifyEmail(token).then(() => setState('ok'))
      .catch((e) => { setState('error'); setMessage(e instanceof ApiError ? e.message : 'Could not verify your email.'); });
  }, [token]);

  return (
    <AuthLayout title={state === 'ok' ? 'Email verified' : state === 'working' ? 'Verifying…' : 'Verification failed'}
      footer={<Link className="link" to={`/login${redirect !== '/' ? `?redirect=${encodeURIComponent(redirect)}` : ''}`}>Go to sign in</Link>}>
      {state === 'working' && <PageLoader />}
      {state === 'ok' && <div className="form-info">Your email is verified. You can sign in now.</div>}
      {state === 'error' && <div className="form-error">{message}</div>}
    </AuthLayout>
  );
}

// ------------------------------------------------------------------ forgot / reset
const emailSchema = z.object({ email: z.string().min(1, 'Enter your email.').email('Enter a valid email.') });

export function ForgotPasswordPage() {
  usePageTitle('Reset your password');
  const [sent, setSent] = useState(false);
  const { register, handleSubmit, formState: { errors } } = useForm<z.infer<typeof emailSchema>>({ resolver: zodResolver(emailSchema) });
  const m = useMutation({ mutationFn: (v: z.infer<typeof emailSchema>) => authApi.forgotPassword(v.email), onSuccess: () => setSent(true) });
  return (
    <AuthLayout title="Reset your password" sub="Enter your email and we'll send you a reset link." footer={<Link className="link" to="/login">Back to sign in</Link>}>
      {sent ? <div className="form-info">If an account exists for that email, a reset link is on its way. It expires in 2 hours.</div> : (
        <form className="auth-form" onSubmit={handleSubmit((v) => m.mutate(v))} noValidate>
          <Field label="Email" error={errors.email?.message}><input className="input" type="email" autoFocus {...register('email')} /></Field>
          <SubmitButton busy={m.isPending}>Send reset link</SubmitButton>
        </form>
      )}
      <DevHint />
    </AuthLayout>
  );
}

type ResetValues = { password: string; confirm: string };

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const token = params.get('token') ?? '';
  const [error, setError] = useState<string | null>(null);
  const { policy, field: passwordField } = usePolicyPassword();
  const resetSchema = useMemo(() => z.object({ password: passwordField, confirm: z.string() })
    .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords do not match.' }), [passwordField]);
  const { register, handleSubmit, watch, setError: setFieldError, formState: { errors } } = useForm<ResetValues>({ resolver: zodResolver(resetSchema) });
  const typed = watch('password') ?? '';
  const m = useMutation({
    mutationFn: (v: ResetValues) => authApi.resetPassword({ token, password: v.password }),
    onSuccess: () => { toast('Password updated. Please sign in.'); nav('/login'); },
    onError: (e) => setError(applyServerErrors(e, setFieldError, ['password'])),
  });
  return (
    <AuthLayout title="Choose a new password" footer={<Link className="link" to="/login">Back to sign in</Link>}>
      {!token ? <div className="form-error">This reset link is invalid.</div> : (
        <form className="auth-form" onSubmit={handleSubmit((v) => { setError(null); m.mutate(v); })} noValidate>
          {error && <div className="form-error" role="alert">{error}</div>}
          <Field label="New password" error={errors.password?.message}><PasswordInput autoComplete="new-password" autoFocus {...register('password')} /></Field>
          <PasswordChecklist policy={policy} password={typed} showHistory />
          <Field label="Confirm password" error={errors.confirm?.message}><PasswordInput autoComplete="new-password" {...register('confirm')} /></Field>
          <SubmitButton busy={m.isPending}>Update password</SubmitButton>
        </form>
      )}
    </AuthLayout>
  );
}

// ------------------------------------------------------------------ accept invitation
export function AcceptInvitePage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const status = useAuth((s) => s.status);
  const user = useAuth((s) => s.ctx?.user);
  const switchWorkspace = useAuth((s) => s.switchWorkspace);
  const [error, setError] = useState<string | null>(null);

  const info = useQuery({ queryKey: ['invite', token], queryFn: () => workspaceApi.lookupInvitation(token), enabled: !!token, retry: false });
  const accept = useMutation({
    mutationFn: () => workspaceApi.acceptInvitation(token),
    onSuccess: async (ws) => { await switchWorkspace(ws.id); toast(`You joined ${ws.name}.`); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not accept the invitation.'),
  });

  const here = `/invite?token=${encodeURIComponent(token)}`;
  const data = info.data;
  return (
    <AuthLayout title="You're invited">
      {!token || info.isError ? <div className="form-error">This invitation link is invalid.</div>
        : info.isLoading || status === 'loading' ? <PageLoader />
        : data && (
          <>
            <p className="auth-sub" style={{ marginBottom: 14 }}>
              {data.invitedBy ? <b>{data.invitedBy}</b> : 'Someone'} invited <b>{data.email}</b> to join <b>{data.workspaceName}</b> as <b>{data.role}</b>{data.jobRole && <> — your job role will be <b>{data.jobRole}</b></>}.
            </p>
            {data.expired ? <div className="form-error">This invitation has expired or was revoked. Ask for a new one.</div>
              : data.accepted ? <div className="form-info">This invitation was already accepted.</div>
              : status !== 'authenticated' ? (
                <div className="auth-form">
                  <Link className="btn btn-primary" to={`/register?email=${encodeURIComponent(data.email)}&redirect=${encodeURIComponent(here)}`}>Create an account</Link>
                  <Link className="btn btn-ghost" to={`/login?redirect=${encodeURIComponent(here)}`}>I already have an account</Link>
                </div>
              ) : (
                <div className="auth-form">
                  {user && user.email.toLowerCase() !== data.email.toLowerCase() && <div className="form-warn">You are signed in as {user.email}. This invitation is for {data.email}.</div>}
                  {error && <div className="form-error">{error}</div>}
                  <button className="btn btn-primary" onClick={() => { setError(null); accept.mutate(); }} disabled={accept.isPending}>Accept invitation</button>
                </div>
              )}
          </>
        )}
    </AuthLayout>
  );
}
