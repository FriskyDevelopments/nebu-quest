# NEBU: the spec

## English

### What NEBU is
NEBU is two things that work together:
1. **A streaming studio in the browser.** Scenes, a mixer, rooms with guests, recording, lower thirds, overlays, transitions, stickers and a DJ mode. Nothing to install.
2. **A group bot that starts on Telegram.** Live chat, reactions, song requests, polls and announcements for your people, inside a Telegram Mini App with a plain web fallback. Discord works if you bring your own bot.

I built it for people who go live with their community: DJs, hosts, creators, and small groups who hang out on Telegram and want their show to feel like theirs.

### Free tier
Sign in with FRISKY ID and you get:
- **The full studio.**
- **One monthly design.** Each month, NEBU makes one element or a small set (up to 5) for you. It uses Stitch through my Hermes dispatcher, powered by Code Pup Design (also sold standalone), and the result lands as a layered, editable pack in **My packs**, stored on Cloudflare R2. If a design fails, you get the month's slot back.
- **How each design is made:**
  - If your idea is vague, a stronger reasoning model first turns it into a concrete design brief. If you already wrote a brief, it goes straight to Stitch.
  - Stitch runs 3 rounds. Between rounds, a vision model checks the screenshot against the brief and writes what to fix next.
  - Every design gets one nice touch: a tasteful extra detail you didn't ask for, in line with your brief and the FR!SKY/NEBU style.
  - The brief and review models are my cost inside the plan, capped per design. They never come out of your credits.
- **Capacity:** right now, Stitch runs on a small pool of accounts through my Hermes dispatcher, so designs wait in a queue and get throttled. Before I sell this at scale, I'll check Stitch's terms and limits and move to an official plan if one exists.

### Core NEBU (not add-ons)
- **Voice.** NEBU reads announcements out loud, ducks the music while it talks, and shows a matching lower third.
- **DJ.** Two decks, a crossfader and BPM detection, using your own local files.
- **Moderation.** Rate limits and slow mode in live chat, host-only controls, and short-lived signed links you can rotate or kill. Model-based filtering is on the roadmap.

### Add-ons
- **Vellum, your personal assistant.** A hosted assistant that runs in its own Cloudflare Container per FRISKY ID and sleeps when idle.
- **FR!sky Paperclip seat link.** Paperclip is my own product, the Agent Ops desk at clip.friskydev.com. It is not the open-source project with a similar name. Link your Paperclip seat to your FRISKY ID and open the desk from NEBU.

Both are designed and switched off in this release.

### AI keys and credits
Bring your own AI keys: they get sealed, shown masked, and you can delete them whenever you want. Or use credits. Plans can include some.

### Plans
- **Free:** studio plus the monthly design.
- **ALL-IN: $99.99 USD / month.** The studio, Your NEBU (your own bot plus the second Telegram account it runs on), a linked FR!sky Paperclip seat, the hosted Vellum assistant, and included AI credits. Checkout is in test mode only for now.
- Every other tier and add-on: price TBD.

### Runtime
All of it runs on Cloudflare: Pages for the site and studio, Workers and Durable Objects for rooms, live chat and signaling, D1 for data, R2 for packs, Workers AI for voice, Realtime TURN for connections, and Containers for the per-user assistant. The user's own bot and second account live in their own isolated Durable Object.

---

## Español

### Qué es NEBU
NEBU son dos cosas que trabajan juntas:
1. **Un estudio de streaming en el navegador.** Escenas, mezclador, salas con invitados, grabación, lower thirds, overlays, transiciones, stickers y modo DJ. No hay que instalar nada.
2. **Un bot de grupo que empieza en Telegram.** Chat en vivo, reacciones, peticiones de canciones, encuestas y anuncios para tu gente, dentro de una Mini App de Telegram, con versión web sencilla. Discord funciona si traes tu propio bot.

Lo hice para quienes transmiten en vivo con su comunidad: DJs, hosts, creadores y grupos pequeños que se juntan en Telegram y quieren que su show se sienta suyo.

### Plan gratis
Entras con tu FRISKY ID y tienes:
- **El estudio completo.**
- **Un diseño al mes.** Cada mes, NEBU te hace un elemento o un set pequeño (hasta 5). Usa Stitch a través de mi despachador Hermes, con tecnología de Code Pup Design (también se vende por separado), y el resultado llega como un pack editable por capas a **Mis packs**, guardado en Cloudflare R2. Si un diseño falla, te regreso el lugar del mes.
- **Cómo se hace cada diseño:**
  - Si tu idea es vaga, un modelo de razonamiento más fuerte primero la convierte en un brief de diseño concreto. Si ya escribiste tu brief, va directo a Stitch.
  - Stitch hace 3 rondas. Entre ronda y ronda, un modelo con visión revisa la captura contra el brief y escribe qué mejorar.
  - Cada diseño lleva un toque especial: un detalle extra de buen gusto que no pediste, en línea con tu brief y el estilo FR!SKY/NEBU.
  - Los modelos del brief y de la revisión los pago yo dentro del plan, con un tope por diseño. Nunca salen de tus créditos.
- **Capacidad:** por ahora Stitch corre en un grupo pequeño de cuentas a través de mi despachador Hermes, así que los diseños esperan en fila y se dosifican. Antes de venderlo a gran escala, voy a revisar los términos y límites de Stitch y pasarme a un plan oficial si existe.

### Lo esencial de NEBU (no son extras)
- **Voz.** NEBU lee los anuncios en voz alta, baja la música mientras habla y muestra un lower third a juego.
- **DJ.** Dos decks, crossfader y detección de BPM, con tus propios archivos.
- **Moderación.** Límites de mensajes y modo lento en el chat, controles solo para el host y enlaces firmados de corta duración que puedes cambiar o cortar. El filtrado con modelos viene después.

### Extras
- **Vellum, tu asistente personal.** Un asistente alojado que corre en su propio Cloudflare Container por cada FRISKY ID y se duerme cuando no lo usas.
- **Enlace con FR!sky Paperclip.** Paperclip es mi propio producto, el escritorio Agent Ops en clip.friskydev.com. No es el proyecto de código abierto con nombre parecido. Vincula tu lugar de Paperclip a tu FRISKY ID y abre el escritorio desde NEBU.

Los dos están diseñados y apagados en esta versión.

### Llaves de IA y créditos
Trae tus propias llaves de IA: se guardan selladas, se muestran enmascaradas y las borras cuando quieras. O usa créditos. Algunos planes los incluyen.

### Planes
- **Gratis:** estudio más el diseño mensual.
- **ALL-IN: $99.99 USD al mes.** El estudio, Tu NEBU (tu propio bot más la segunda cuenta de Telegram donde corre), un lugar de FR!sky Paperclip vinculado, el asistente Vellum alojado y créditos de IA incluidos. Por ahora el pago está solo en modo de prueba.
- Los demás planes y extras: precio por definir.

### Dónde corre
Todo corre en Cloudflare: Pages para el sitio y el estudio, Workers y Durable Objects para salas, chat en vivo y señalización, D1 para datos, R2 para packs, Workers AI para la voz, Realtime TURN para las conexiones y Containers para el asistente de cada persona. El bot propio y la segunda cuenta de cada quien viven en su propio Durable Object aislado.
