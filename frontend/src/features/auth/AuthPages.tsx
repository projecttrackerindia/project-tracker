import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { authApi, consentApi, workspaceApi } from '../../api/endpoints';
import { Field, Modal, PageLoader, PasswordInput, SubmitButton, applyServerErrors } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { AuthLayout } from '../../layouts/AuthLayout';
import { useAuth } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { AuthSubmitButton, AuthSuccessOverlay, FloatingField, PasswordField, useShake } from './AuthFields';
import { PasswordChecklist, passwordProblem, usePasswordPolicy } from './passwordPolicy';

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

const safeRedirect = (r: string | null) => (r && r.startsWith('/') && !r.startsWith('//') ? r : '/');

/**
 * Google / GitHub / Apple sign-in, matching the reference design. None of these are wired up yet (that needs OAuth app
 * credentials for each provider), so a click says so plainly rather than pretending to sign the person in.
 */
function SocialButtons() {
  const notReady = (provider: string) => toast(`Sign in with ${provider} isn't set up yet. Use your email and password for now.`, 'info');
  return (
    <>
      <div className="auth-divider">or continue with</div>
      <div className="auth-socials">
        <button type="button" className="auth-social" onClick={() => notReady('Google')} aria-label="Continue with Google">
          <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
          </svg>
          <span>Google</span>
        </button>
        <button type="button" className="auth-social" onClick={() => notReady('GitHub')} aria-label="Continue with GitHub">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
            <path d="M12 .5A11.5 11.5 0 0 0 .5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.2 1.77 1.2 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.12 3.05.74.81 1.18 1.84 1.18 3.1 0 4.43-2.69 5.4-5.25 5.69.41.36.78 1.06.78 2.14v3.17c0 .31.2.67.8.56A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5Z" />
          </svg>
          <span>GitHub</span>
        </button>
        <button type="button" className="auth-social" onClick={() => notReady('Apple')} aria-label="Continue with Apple">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
            <path d="M16.36 12.72c-.02-2.3 1.88-3.4 1.96-3.46-1.07-1.56-2.73-1.78-3.32-1.8-1.41-.14-2.76.83-3.48.83-.72 0-1.83-.81-3.01-.79-1.55.02-2.98.9-3.78 2.29-1.61 2.79-.41 6.93 1.16 9.2.77 1.11 1.68 2.36 2.88 2.31 1.16-.05 1.6-.75 3-.75s1.79.75 3.01.73c1.24-.02 2.03-1.13 2.79-2.25.88-1.29 1.24-2.54 1.26-2.6-.03-.01-2.42-.93-2.44-3.68l-.03-.03ZM14.1 5.4c.64-.77 1.07-1.85.95-2.92-.92.04-2.03.61-2.69 1.38-.59.68-1.11 1.78-.97 2.83 1.03.08 2.07-.52 2.71-1.29Z" />
          </svg>
          <span>Apple</span>
        </button>
      </div>
    </>
  );
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
  const status = useAuth((s) => s.status);
  const login = useAuth((s) => s.login);
  const loginMfa = useAuth((s) => s.loginMfa);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [unverified, setUnverified] = useState(false);
  const [remember, setRemember] = useState(() => !!rememberedEmail());
  const [shaking, shake] = useShake();
  const [celebrating, setCelebrating] = useState(false);
  const { register, handleSubmit, getValues, formState: { errors } } = useForm<z.infer<typeof loginSchema>>({
    resolver: zodResolver(loginSchema), defaultValues: { email: rememberedEmail(), password: '' },
  });
  const redirect = safeRedirect(params.get('redirect'));

  const m = useMutation({
    mutationFn: (v: z.infer<typeof loginSchema>) => login(v.email, v.password),
    onSuccess: (r, v) => {
      try { if (remember) localStorage.setItem(REMEMBERED_EMAIL_KEY, v.email); else localStorage.removeItem(REMEMBERED_EMAIL_KEY); } catch { /* storage unavailable */ }
      if (r.mfaChallenge) { setChallenge(r.mfaChallenge); setCode(''); return; }
      setCelebrating(true);
      window.setTimeout(() => nav(redirect, { replace: true }), 650);
    },
    onError: (e) => {
      setUnverified(e instanceof ApiError && e.code === 'EMAIL_NOT_VERIFIED');
      setError(e instanceof ApiError ? e.message : 'Could not sign in. Please try again.');
      shake();
    },
  });
  const verify = useMutation({
    mutationFn: () => loginMfa(challenge!, code),
    onSuccess: () => { setCelebrating(true); window.setTimeout(() => nav(redirect, { replace: true }), 650); },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'MFA_CHALLENGE_INVALID') { setChallenge(null); setError(e.message); return; }
      setError(e instanceof ApiError ? e.message : 'Could not verify the code. Please try again.');
      shake();
    },
  });
  const resend = useMutation({ mutationFn: () => authApi.resendVerification(getValues('email')), onSuccess: () => toast('Verification email sent (if the account exists).', 'info') });

  if (status === 'authenticated' && !celebrating) return <Navigate to={redirect} replace />;
  if (challenge) return (
    <AuthLayout title="Two-step verification" sub="Enter the 6-digit code from your authenticator app, or one of your recovery codes." shake={shaking}
      footer={<button type="button" className="link" onClick={() => { setChallenge(null); setError(null); }}>Back to sign in</button>}>
      {celebrating && <AuthSuccessOverlay title="Verified" sub="Signing you in…" />}
      <form className="auth-form" onSubmit={(e) => { e.preventDefault(); setError(null); if (code.trim()) verify.mutate(); else shake(); }} noValidate>
        {error && <div className="form-error" role="alert">{error}</div>}
        <FloatingField id="mfa-code" icon="shield" label="Verification code" autoComplete="one-time-code" inputMode="text" autoFocus
          value={code} onChange={(e) => setCode(e.target.value)} />
        <AuthSubmitButton busy={verify.isPending}>Verify and sign in<Icon name="arrowRight" /></AuthSubmitButton>
      </form>
    </AuthLayout>
  );
  return (
    <AuthLayout title="Welcome back" sub="Sign in to continue to your workspace." shake={shaking}
      footer={<>New here? <Link className="link" to={`/register${redirect !== '/' ? `?redirect=${encodeURIComponent(redirect)}` : ''}`}>Create an account</Link></>}>
      {celebrating && <AuthSuccessOverlay title="Welcome back!" sub="Taking you to your workspace…" />}
      <form className="auth-form" onSubmit={handleSubmit((v) => { setError(null); m.mutate(v); }, () => shake())} noValidate>
        {error && <div className="form-error" role="alert">{error}{unverified && <> <button type="button" className="link" onClick={() => resend.mutate()}>Resend verification email</button></>}</div>}
        <FloatingField id="email" icon="mail" label="Email address" type="email" autoComplete="email" autoFocus error={errors.email?.message} {...register('email')} />
        <PasswordField id="password" label="Password" autoComplete="current-password" error={errors.password?.message} {...register('password')} />
        <div className="auth-row">
          <label className="auth-remember"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />Remember me</label>
          <Link className="link" to="/forgot-password" style={{ fontSize: 13.5 }}>Forgot password?</Link>
        </div>
        <AuthSubmitButton busy={m.isPending}>Sign in<Icon name="arrowRight" /></AuthSubmitButton>
        <SocialButtons />
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
    mutationFn: (v: RegisterValues) => authApi.register({ email: v.email, password: v.password, displayName: v.displayName, acceptedTerms: v.acceptedTerms }),
    onSuccess: (_r, v) => setDone(v.email),
    onError: (e) => setError(applyServerErrors(e, setFieldError, ['email', 'password', 'displayName'])),
  });

  if (status === 'authenticated') return <Navigate to={redirect} replace />;
  if (done) return (
    <AuthLayout title="Check your email" sub={`We sent a verification link to ${done}. Open it to activate your account, then sign in.`}
      footer={<Link className="link" to={`/login${redirect !== '/' ? `?redirect=${encodeURIComponent(redirect)}` : ''}`}>Go to sign in</Link>}>
      <div className="form-info"><Icon name="mail" size={14} /> The link expires in 24 hours.</div>
      <DevHint />
    </AuthLayout>
  );
  return (
    <AuthLayout title="Create your account" sub="Start with a free personal workspace. Create or join an organization anytime."
      footer={<>Already have an account? <Link className="link" to="/login">Sign in</Link></>}>
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
      footer={<Link className="link" to="/login">Go to sign in</Link>}>
      {state === 'working' && <PageLoader />}
      {state === 'ok' && <div className="form-info">Your email is verified. You can sign in now.</div>}
      {state === 'error' && <div className="form-error">{message}</div>}
    </AuthLayout>
  );
}

// ------------------------------------------------------------------ forgot / reset
const emailSchema = z.object({ email: z.string().min(1, 'Enter your email.').email('Enter a valid email.') });

export function ForgotPasswordPage() {
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
  const nav = useNavigate();
  const [error, setError] = useState<string | null>(null);

  const info = useQuery({ queryKey: ['invite', token], queryFn: () => workspaceApi.lookupInvitation(token), enabled: !!token, retry: false });
  const accept = useMutation({
    mutationFn: () => workspaceApi.acceptInvitation(token),
    onSuccess: async (ws) => { await switchWorkspace(ws.id); toast(`You joined ${ws.name}.`); nav('/', { replace: true }); },
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
