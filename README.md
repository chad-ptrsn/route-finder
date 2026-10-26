# Chaska Adventure Map

A Nuxt/Vue map prototype for exploring Chaska, Minnesota, and building a personal running or walking route.

## Run locally

Requires Node.js 20 or newer.

```sh
npm install
npm run dev
```

## Deploy to Cloudflare Pages from GitHub

1. Put the contents of this folder at the root of a GitHub repository and push the repository.
2. In Cloudflare, open **Workers & Pages → Create application → Pages → Connect to Git** and select the repository.
3. Use these build settings:

   - Build command: `npm run generate`
   - Build output directory: `.output/public`
   - Root directory: `/` (if this app is the repository root)

4. Save and deploy. Cloudflare Pages will build preview deployments for pull requests and production deployments from the selected branch.

No API keys or Cloudflare bindings are required for this prototype. The map needs network access to OpenStreetMap tiles and the Carver County ArcGIS trail service.

## Current scope

- MapLibre GL JS map centered on Chaska, with zoom and current-location controls.
- City trail layers from the Carver County ArcGIS FeatureServer.
- Draw route points or select/unselect mapped trail segments.
- Distance and known/unknown surface summaries.
- Save and restore one route in browser local storage.

Drawn route geometry is not snapped to the trail network. Selected trail features are measured individually; the app does not yet determine whether selected segments connect. Elevation, route snapping, and turn-by-turn navigation are not included.

## Data and attribution

- Trail lines: [Carver County / City of Chaska ArcGIS FeatureServer](https://gis.co.carver.mn.us/arcgis_ca/rest/services/Chaska/Chaska_ParksRec_Trails/FeatureServer)
- Basemap tiles: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)

Trail attributes and access information may be incomplete or out of date. Confirm conditions before heading out. Check the source terms before redistributing city trail data or building a public data export.
