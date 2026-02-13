/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./*.html",
    "./src/js/**/*.js"
  ],
  theme: {
    extend: {
      fontFamily: {
        'inter': ['Inter', 'sans-serif'],
      },
      colors: {
        'dark-bg': '#121212',
        'dark-surface': '#181818',
        'dark-card': '#1e1e1e',
      },
    },
  },
  plugins: [],
}
