/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  productionBrowserSourceMaps: false,
  poweredByHeader: false,
  eslint: {
    ignoreDuringBuilds: true,
  },
  experimental: {
    // googleapis ships every Google API surface as one package. Bundling it
    // into the server output balloons the build and trips Next's static
    // analysis on its dynamic requires. It only ever runs in Node route
    // handlers, so leave it external and let require() find it at runtime.
    //
    // Next 14 spelling. Next 15 renamed this to a top-level
    // serverExternalPackages — using that spelling here silently does nothing.
    serverComponentsExternalPackages: ["googleapis"],
    optimizePackageImports: [
      "lucide-react",
      "recharts",
      "date-fns",
      "@radix-ui/react-alert-dialog",
      "@radix-ui/react-avatar",
      "@radix-ui/react-checkbox",
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-label",
      "@radix-ui/react-popover",
      "@radix-ui/react-progress",
      "@radix-ui/react-radio-group",
      "@radix-ui/react-scroll-area",
      "@radix-ui/react-select",
      "@radix-ui/react-separator",
      "@radix-ui/react-slot",
      "@radix-ui/react-switch",
      "@radix-ui/react-tabs",
      "@radix-ui/react-tooltip",
      "@tanstack/react-table",
      "react-day-picker",
      "cmdk",
      "sonner",
    ],
  },
};

export default nextConfig;
