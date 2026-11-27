// Serveur photo de Flip&Flop (Cloudflare Worker).
// Il reçoit la photo d'une main de poker (prise APRÈS la partie), la montre à Claude,
// et renvoie les cartes reconnues. La clé Anthropic reste cachée ici, jamais dans l'appli.
import Anthropic from "@anthropic-ai/sdk";

// Sites autorisés à utiliser ce serveur
const ORIGINES = ["https://yanishg90.github.io", "http://localhost:8765"];

const RANGS = "23456789TJQKA";
const COULEURS = "shdc"; // s = pique, h = cœur, d = carreau, c = trèfle
const CARTES = [...RANGS].flatMap((r) => [...COULEURS].map((s) => r + s));
const carte = { type: "string", enum: CARTES };

const SCHEMA = {
  type: "object",
  properties: {
    hero: { type: "array", items: carte, description: "Les 2 cartes du joueur (en bas de la photo)" },
    board: { type: "array", items: carte, description: "Les cartes du tableau, de gauche à droite (0, 3, 4 ou 5)" },
    villain: { type: "array", items: carte, description: "Les 2 cartes de l'adversaire si elles sont visibles (en haut), sinon vide" },
    note: { type: "string", description: "Remarque courte en français : carte illisible, doute, etc. Vide si tout est clair." },
  },
  required: ["hero", "board", "villain", "note"],
  additionalProperties: false,
};

const CONSIGNE = `Cette photo montre une main de poker Texas Hold'em reposée sur une table APRÈS la partie, pour l'étudier.
Disposition habituelle : les 2 cartes du joueur en bas de la photo, les cartes du tableau (flop, turn, river) en ligne au milieu, et éventuellement les 2 cartes de l'adversaire en haut.
Identifie chaque carte visible face découverte. Notation : rang parmi 2 3 4 5 6 7 8 9 T J Q K A (T = 10, J = Valet, Q = Dame, K = Roi, A = As) suivi de la couleur : s = pique, h = cœur, d = carreau, c = trèfle.
Ne devine jamais une carte que tu ne peux pas lire avec certitude : laisse-la de côté et explique-le dans "note". Ignore les cartes face cachée.
Chaque carte ne peut apparaître qu'une seule fois.`;

function entetes(origine) {
  return {
    "Access-Control-Allow-Origin": origine,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-App-Code",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
const json = (corps, statut, origine) =>
  new Response(JSON.stringify(corps), { status: statut, headers: { "Content-Type": "application/json", ...entetes(origine) } });

export default {
  async fetch(requete, env) {
    const origine = requete.headers.get("Origin") || "";
    if (!ORIGINES.includes(origine)) return new Response("Interdit", { status: 403 });
    if (requete.method === "OPTIONS") return new Response(null, { status: 204, headers: entetes(origine) });
    if (requete.method !== "POST") return json({ erreur: "Méthode non autorisée" }, 405, origine);

    // Code d'accès choisi par le propriétaire (pour que personne d'autre n'utilise le serveur à ses frais)
    if (!env.APP_CODE || requete.headers.get("X-App-Code") !== env.APP_CODE)
      return json({ erreur: "code" }, 401, origine);

    let donnees;
    try { donnees = await requete.json(); } catch { return json({ erreur: "Requête illisible" }, 400, origine); }
    const image = String(donnees.image || "");
    const type = ["image/jpeg", "image/png", "image/webp"].includes(donnees.type) ? donnees.type : "image/jpeg";
    if (!image || image.length > 3_000_000) return json({ erreur: "Photo absente ou trop lourde" }, 400, origine);

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    try {
      const reponse = await client.beta.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 4000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: type, data: image } },
            { type: "text", text: CONSIGNE },
          ],
        }],
      });
      if (reponse.stop_reason === "refusal") return json({ erreur: "refus" }, 422, origine);
      const texte = reponse.content.find((b) => b.type === "text");
      if (!texte) return json({ erreur: "Pas de réponse" }, 502, origine);
      const resultat = JSON.parse(texte.text);
      // vérification : cartes valides et sans doublon
      const vues = new Set();
      const propre = (liste) => (Array.isArray(liste) ? liste : []).filter((c) => CARTES.includes(c) && !vues.has(c) && vues.add(c));
      return json({ hero: propre(resultat.hero).slice(0, 2), board: propre(resultat.board).slice(0, 5), villain: propre(resultat.villain).slice(0, 2), note: String(resultat.note || "") }, 200, origine);
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) return json({ erreur: "cle" }, 500, origine);
      if (e instanceof Anthropic.RateLimitError) return json({ erreur: "limite" }, 429, origine);
      if (e instanceof Anthropic.BadRequestError) return json({ erreur: "Photo refusée : " + e.message }, 400, origine);
      if (e instanceof Anthropic.APIError) return json({ erreur: "Service indisponible (" + e.status + ")" }, 502, origine);
      return json({ erreur: "Erreur inattendue" }, 500, origine);
    }
  },
};
