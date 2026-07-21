// Bare, full-viewport layout — the desktop owns the whole screen. Its design system
// lives in app/global.css (linked from index.html), a copy of the desktop package's
// stylesheet — otfw serves each app's own app/global.css, the same as the website.
export default function RootLayout({ children }) {
  return <>{children}</>;
}
