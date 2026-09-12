/**
 * SMS/OTP provider adapter — spec 005 §8 risk #1 (Decided). A swappable interface so picking a
 * real vendor (Twilio or a Pakistan-capable alternative) later is a new implementation of this
 * interface, not a rewrite of every call site. Only a sandbox implementation ships in this spec,
 * per master spec §133.7 and spec 005 §6 "Not covered, deliberately."
 */
export interface SmsOtpProvider {
  send(phoneNumber: string, code: string): Promise<void>;
}

/**
 * Sandbox implementation: sends nothing externally. Logs to stdout (dev visibility) and remembers
 * the last code sent per phone number so tests/dev tooling can read it back without needing a
 * real SMS inbox — mirrors how a real provider's test/sandbox mode works.
 */
class SandboxSmsOtpProvider implements SmsOtpProvider {
  private lastSentByPhone = new Map<string, string>();

  async send(phoneNumber: string, code: string): Promise<void> {
    this.lastSentByPhone.set(phoneNumber, code);
    console.log(`[sms-otp-sandbox] would send "${code}" to ${phoneNumber}`);
  }

  /** Test/dev-only: read back the last code sent to a phone number. */
  getLastSentCode(phoneNumber: string): string | undefined {
    return this.lastSentByPhone.get(phoneNumber);
  }

  reset(): void {
    this.lastSentByPhone.clear();
  }
}

const sandboxProvider = new SandboxSmsOtpProvider();

/** Only the sandbox is wired up for now (§8 risk #1) — swap this factory when a real vendor ships. */
export function getSmsOtpProvider(): SmsOtpProvider {
  return sandboxProvider;
}

/** Test-only escape hatch into the sandbox's captured state. */
export function getSandboxSmsProvider(): SandboxSmsOtpProvider {
  return sandboxProvider;
}
