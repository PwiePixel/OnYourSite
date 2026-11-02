// Anmeldeseite (views/login.php). Der Text außerhalb der PHP-Teile ist Byte für Byte übernommen (view2ts).
import { e } from '../../html.js';
import { asset } from '../../helpers.js';
import { phpTruthy } from '../../php.js';
import { uiAssets } from '../../views/partials/ui.js';

export interface LoginViewData {
  // $_SESSION['error'] / $_SESSION['success'] (schon aus der Sitzung entfernt)
  flashError: unknown;
  flashSuccess: unknown;
  // oys_csrf_field()
  csrfField: string;
}

export function loginView(d: LoginViewData): string {
  let o = '';
  o += "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n    <meta charset=\"UTF-8\">\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n    <!-- Die Seite ist schon dunkel: kein Nachtmodus des Browsers darüber (z. B. Brave, Dark Reader) -->\n    <meta name=\"color-scheme\" content=\"dark\">\n    <meta name=\"darkreader-lock\">\n    <title>Log in | OnYourSite</title>\n    <link rel=\"icon\" type=\"image/png\" href=\"/static/images/favicon.png\">\n    <link href=\"https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap\" rel=\"stylesheet\">\n    <link rel=\"stylesheet\" href=\"";
  o += e(asset('/static/vendor/boxicons/css/boxicons.min.css'));
  o += "\">\n    <script src=\"https://cdn.tailwindcss.com\"></script>\n    <script>\n        tailwind.config = {\n            theme: {\n                extend: {\n                    fontFamily: { sans: ['Inter', 'sans-serif'], },\n                    colors: {\n                        background: '#09090b', card: '#18181b', bordercolor: 'rgba(255, 255, 255, 0.08)',\n                        brand: { 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5', }\n                    }\n                }\n            }\n        }\n    </script>\n    <style>\n        /* iOS zoomt bei Eingaben unter 16px ungefragt in die Seite */\n        @media (max-width: 639px) { input:not([type=checkbox]):not([type=radio]), select, textarea { font-size: 16px !important; } }\n    </style>\n" + "    " + uiAssets('app') + "\n</head>\n<body class=\"bg-background text-gray-300 font-sans min-h-screen flex flex-col items-center justify-center relative overflow-x-hidden selection:bg-brand-500/30 py-16\">\n\n    <div class=\"absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[600px] bg-white/5 rounded-full blur-[100px] -z-10 pointer-events-none\"></div>\n\n    <a href=\"/\" class=\"absolute top-6 left-6 py-2 text-gray-500 hover:text-white flex items-center gap-2 transition-colors\">\n        <i class='bx bx-left-arrow-alt text-2xl'></i> Back to home\n    </a>\n\n    <div class=\"w-full max-w-md p-8 md:p-10 bg-card rounded-3xl border border-bordercolor shadow-2xl relative z-10 mx-4\">\n        <div class=\"flex justify-center mb-8\">\n            <i class='bx bx-hive text-5xl text-white'></i>\n        </div>\n\n        <h2 class=\"text-3xl font-bold text-white text-center mb-2\">Welcome back</h2>\n        <p class=\"text-gray-400 text-center mb-8\">Log in to edit your page.</p>\n\n        ";
  if (phpTruthy(d.flashError)) {
    o += "            <div class=\"mb-6 bg-red-500/10 border border-red-500/20 text-red-400 p-3 rounded-lg flex items-center gap-2 text-sm font-medium\">\n                <i class='bx bx-error-circle text-lg'></i> ";
    o += e(d.flashError);
    o += "            </div>\n        ";
  }
  o += "        ";
  if (phpTruthy(d.flashSuccess)) {
    o += "            <div class=\"mb-6 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 p-3 rounded-lg flex items-center gap-2 text-sm font-medium\">\n                <i class='bx bx-check-circle text-lg'></i> ";
    o += e(d.flashSuccess);
    o += "            </div>\n        ";
  }
  o += "\n        <form action=\"/login\" method=\"POST\" class=\"space-y-5\">\n            ";
  o += d.csrfField;
  o += "            <div>\n                <label class=\"block text-sm font-medium text-gray-300 mb-2\">Email address</label>\n                <input type=\"email\" name=\"email\" required data-error-required=\"Please enter your email address.\" autocomplete=\"email\" placeholder=\"max@example.com\" class=\"w-full bg-[#09090b] border border-bordercolor rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-gray-400 transition-all\">\n            </div>\n\n            <div>\n                <label class=\"block text-sm font-medium text-gray-300 mb-2\">Password</label>\n                <input type=\"password\" name=\"password\" required data-error-required=\"Please enter your password.\" autocomplete=\"current-password\" placeholder=\"••••••••\" class=\"w-full bg-[#09090b] border border-bordercolor rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-gray-400 transition-all\">\n            </div>\n\n            <button type=\"submit\" class=\"w-full bg-white text-black hover:bg-gray-200 font-bold py-3.5 rounded-xl transition-all duration-300 mt-4\">\n                Log in\n            </button>\n        </form>\n\n        <p class=\"text-center text-gray-500 mt-8 text-sm\">\n            Don’t have an account? <a href=\"/register\" class=\"text-white hover:text-gray-300 font-medium transition-colors\">Sign up now</a>\n        </p>\n    </div>\n\n</body>\n</html>\n";
  return o;
}
