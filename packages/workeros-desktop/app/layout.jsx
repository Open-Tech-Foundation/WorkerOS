// Bare, full-viewport layout — no marketing navbar/footer. The desktop owns the whole
// screen (its own theme engine, wallpaper, dock). global.css is linked from index.html.
export default function RootLayout({ children }) {
  return <>{children}</>;
}
