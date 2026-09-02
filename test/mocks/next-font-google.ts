// next/font/google only works inside Next's own SWC/Turbopack build pipeline (it compiles to an
// empty module outside of it). Vitest runs under Vite instead, so this stub stands in for it —
// aliased in vitest.config.ts — returning just enough shape (`variable`) for app/fonts.ts to run.
type FontOptions = { variable?: string };
type FontOutput = { variable: string; className: string };

function stubFont(name: string) {
  return (options: FontOptions = {}): FontOutput => {
    const variable = options.variable ?? `--font-${name}`;
    return { variable: `${variable}-mock`, className: `${variable}-mock` };
  };
}

export const Sora = stubFont('sora');
export const Source_Sans_3 = stubFont('source-sans-3');
export const IBM_Plex_Mono = stubFont('ibm-plex-mono');
export const Noto_Nastaliq_Urdu = stubFont('noto-nastaliq-urdu');
