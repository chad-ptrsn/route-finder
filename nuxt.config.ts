export default defineNuxtConfig({
  compatibilityDate: '2026-10-26',
  devtools: { enabled: true },
  css: ['~/assets/css/main.css'],
  ssr: false,
  app: {
    head: {
      title: 'Chaska Adventure Map',
      meta: [
        { name: 'description', content: 'Explore Chaska trails and build your own run or walk.' },
        { name: 'theme-color', content: '#f6f5ef' },
      ],
    },
  },
  nitro: { preset: 'static' },
})
