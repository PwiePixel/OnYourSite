// Registrierung (views/register.php). Der Text außerhalb der PHP-Teile ist Byte für Byte übernommen (view2ts).
import { e } from '../../html.js';
import { asset, baseAuthority } from '../../helpers.js';
import { phpTruthy } from '../../php.js';

export interface RegisterViewData {
  // $_SESSION['error'] (schon aus der Sitzung entfernt)
  flashError: unknown;
  // Eingaben des letzten Versuchs ($_SESSION['old'], ggf. subdomain aus ?name=)
  old: Record<string, unknown>;
  // oys_csrf_field()
  csrfField: string;
}

export function registerView(d: RegisterViewData): string {
  let o = '';
  const old = d.old;
  o += "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n    <meta charset=\"UTF-8\">\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n    <!-- Die Seite ist schon dunkel: kein Nachtmodus des Browsers darüber (z. B. Brave, Dark Reader) -->\n    <meta name=\"color-scheme\" content=\"dark\">\n    <meta name=\"darkreader-lock\">\n    <title>Create account | OnYourSite</title>\n\t<link rel=\"icon\" type=\"image/png\" href=\"/static/images/favicon.png\">\n    <link href=\"https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap\" rel=\"stylesheet\">\n    <link rel=\"stylesheet\" href=\"";
  o += e(asset('/static/vendor/boxicons/css/boxicons.min.css'));
  o += "\">\n    <script src=\"https://cdn.tailwindcss.com\"></script>\n    <script>\n        tailwind.config = {\n            theme: {\n                extend: {\n                    fontFamily: { sans: ['Inter', 'sans-serif'], },\n                    colors: {\n                        background: '#000000', card: '#0a0a0a', inputbg: '#121212', bordercolor: '#27272a',\n                        brand: { 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5', }\n                    }\n                }\n            }\n        }\n    </script>\n    <style>\n        /* iOS zoomt bei Eingaben unter 16px ungefragt in die Seite */\n        @media (max-width: 639px) { input:not([type=checkbox]):not([type=radio]), select, textarea { font-size: 16px !important; } }\n    </style>\n</head>\n<body class=\"bg-background text-gray-300 font-sans min-h-screen flex flex-col items-center justify-center relative overflow-x-hidden selection:bg-brand-500/30 py-16\">\n\n    <div class=\"absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[800px] bg-brand-500/10 rounded-full blur-[120px] -z-10 pointer-events-none\"></div>\n\n    <a href=\"/\" class=\"absolute top-6 left-6 py-2 text-gray-500 hover:text-white flex items-center gap-2 transition-colors text-sm font-medium\">\n        <i class='bx bx-left-arrow-alt text-xl'></i> Back to home\n    </a>\n\n    <div class=\"w-full max-w-md p-8 md:p-10 bg-card rounded-2xl border border-bordercolor shadow-2xl relative z-10 mx-4\">\n\n        <div class=\"flex justify-center mb-6\">\n            <div class=\"w-12 h-12 rounded-lg bg-gradient-to-br from-brand-500 to-purple-600 flex items-center justify-center shadow-lg shadow-brand-500/20\">\n                <i class='bx bx-hive text-2xl text-white'></i>\n            </div>\n        </div>\n\n        <h2 class=\"text-2xl font-bold text-white text-center mb-2 tracking-tight\">Create your account</h2>\n        <p class=\"text-gray-400 text-center mb-8 text-sm\">Claim your address and get started – for free.</p>\n\n        ";
  if (phpTruthy(d.flashError)) {
    o += "            <div class=\"mb-6 bg-red-500/10 border border-red-500/20 text-red-400 p-3 rounded-lg flex items-center gap-2 text-sm font-medium\">\n                <i class='bx bx-error-circle text-lg'></i> ";
    o += e(d.flashError);
    o += "            </div>\n        ";
  }
  o += "\n        <form action=\"/register\" method=\"POST\" class=\"space-y-5\">\n            ";
  o += d.csrfField;
  o += "            <div>\n                <label class=\"block text-sm font-medium text-gray-300 mb-1.5\">Your address</label>\n                <div class=\"flex shadow-sm rounded-lg overflow-hidden focus-within:ring-1 focus-within:ring-brand-500 transition-all border border-bordercolor\">\n                    <input type=\"text\" name=\"subdomain\" id=\"regSlug\" required maxlength=\"30\" value=\"";
  o += e(old.subdomain ?? '');
  o += "\" placeholder=\"e.g. max\" autocomplete=\"off\" class=\"w-full bg-inputbg px-4 py-2.5 text-white focus:outline-none text-sm\">\n                    <span class=\"inline-flex items-center px-3 bg-card border-l border-bordercolor text-gray-500 text-xs font-medium\">.";
  o += e(baseAuthority());
  o += "</span>\n                </div>\n                <p class=\"text-[11px] text-gray-500 mt-1.5\">Also available at <span class=\"text-gray-400\">";
  o += e(baseAuthority());
  o += "/<span id=\"regSlugEcho\">";
  o += e(phpTruthy(old.subdomain) ? old.subdomain : 'max');
  o += "</span></span> – later you choose which one is your primary address.</p>\n            </div>\n\n            <div>\n                <label class=\"block text-sm font-medium text-gray-300 mb-1.5\">Name</label>\n                <input type=\"text\" name=\"fullname\" required maxlength=\"120\" value=\"";
  o += e(old.fullname ?? '');
  o += "\" placeholder=\"Max Smith\" autocomplete=\"name\" class=\"w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 transition-all text-sm\">\n            </div>\n\n            <div>\n                <label class=\"block text-sm font-medium text-gray-300 mb-1.5\">Email address</label>\n                <input type=\"email\" name=\"email\" required value=\"";
  o += e(old.email ?? '');
  o += "\" placeholder=\"max@example.com\" autocomplete=\"email\" class=\"w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 transition-all text-sm\">\n            </div>\n\n            <div>\n                <label class=\"block text-sm font-medium text-gray-300 mb-1.5\">Password</label>\n                <input type=\"password\" name=\"password\" required minlength=\"8\" placeholder=\"At least 8 characters\" autocomplete=\"new-password\" class=\"w-full bg-inputbg border border-bordercolor rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-1 focus:ring-brand-500 transition-all text-sm\">\n            </div>\n\n            <button type=\"submit\" class=\"w-full bg-white text-black hover:bg-gray-200 font-bold py-2.5 rounded-lg transition-all duration-300 mt-2 shadow-sm text-sm\">\n                Sign up for free\n            </button>\n            <p class=\"text-[11px] text-gray-500 text-center\">By signing up, you accept the <a href=\"/terms\" class=\"underline hover:text-white\">Terms of Service</a> and the <a href=\"/privacy\" class=\"underline hover:text-white\">Privacy Policy</a>.</p>\n        </form>\n\n        <p class=\"text-center text-gray-500 mt-8 text-sm\">\n            Already have an account? <a href=\"/login\" class=\"text-white hover:text-brand-400 font-medium transition-colors\">Log in</a>\n        </p>\n    </div>\n\n    <script>\n        (function () {\n            var input = document.getElementById('regSlug'), echo = document.getElementById('regSlugEcho');\n            input.addEventListener('input', function () {\n                input.value = input.value.toLowerCase().replace(/[^a-z0-9-]/g, '');\n                echo.textContent = input.value || 'max';\n            });\n        })();\n    </script>\n</body>\n</html>\n";
  return o;
}
