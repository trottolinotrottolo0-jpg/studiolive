# StudioLive

Regia per dirette in stile StreamYard, tutta nel browser:

- **Accesso con Google** per chi fa la regia. Gli ospiti entrano da un link, senza account.
- **Ospiti** in backstage, poi in onda con un clic. Volume e muto per ognuno, chat privata.
- **Layout** Auto, Solo, Affiancati, Griglia, Relatore, Schermo. Banner, scritta che scorre, logo, sfondo, overlay e pausa.
- **Uscita per OBS**: Browser Source 1920×1080 con l'audio mixato in stereo.
- **Registrazione** della diretta completa e/o di ogni persona su file separato, nel **proprio Google Drive** (cartella `StudioLive`) oppure in una **cartella del computer**.

Video e audio passano direttamente tra i browser (WebRTC). PeerJS serve solo a far trovare regia, ospiti e OBS.

## Configurazione
In `lib/config.js` va messo l'ID client OAuth Google (tipo "Applicazione web"), con questa origine JavaScript autorizzata:
`https://trottolinotrottolo0-jpg.github.io`

Prove in locale: `python3 -m http.server 8080`, poi `http://localhost:8080/studio.html?dev=1` (salta l'accesso solo su localhost).
