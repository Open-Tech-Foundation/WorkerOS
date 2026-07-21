// Bare, full-viewport layout — the desktop owns the whole screen. Its design system
// (global.css) is linked from index.html: app/global.css is a symlink to the desktop
// package's stylesheet (otfw can't bundle CSS imported from JS), so it stays live
// with the package without being copied.
export default function RootLayout({ children }) {
  return <>{children}</>;
}
