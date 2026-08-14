(function () {
	/**
	 * ============================================================
	 * 1. KONFIGURATION & GLOBALE VARIABLEN
	 * ============================================================
	 */

	// Datenbank Namen
	const CONFIG = {
		DB_COL: "tournaments",  // Turnier Sammlung
		DB_DOC: "active_tournament", // Turnier Dokument
		ASSETS_DOC: "global_assets", // Globale Assets (Regeln, Dartautomat)
		USERS_COL: "users", // User Sammlung
		ADMIN_COL: "Admin", // Admin Sammlung
		ARCHIVES_COL: "tournament_archives", // Archivierte Turniere
		FORMS_COL: "forms", // Feedback Formulare
		RESPONSES_COL: "responses", // Feedback Antworten
		REGISTRATIONS_COL: "registrations", // Turnieranmeldungen
		REG_SETTINGS_DOC: "registration_settings", // Einstellungen für Anmeldung
		GAMES_COL: "planned_games" // Geplante Spiele
	};

	// aktuelle Zustand der App
	let state = {
		isAdmin: false,
		tournament: null,
		globalAssets: {},
		editingMatch: null,
		currentUser: null,
		viewingArchive: false,
		archivedTournaments: [],
		activeForms: [],
		currentForm: null,
		plannedGames: [],
		selectedDate: new Date().toISOString().split('T')[0],
		currentCalendarMonth: new Date(),
		currentGroupIndex: null
	};

	let isSavingGame = false;

	/**
	 * ============================================================
	 * 2. HILFSFUNKTIONEN (SICHERHEIT)
	 * ============================================================
	 */

	// Prüft ob der aktuelle User Admin-Rechte hatE
	function requireAdmin() {
		if (!state.isAdmin) {
			showToast("Zugriff verweigert: Admin-Rechte erforderlich!", "danger");
			console.error("Sicherheitswarnung: Nicht-Admin versucht Admin-Aktion!");
			return false;
		}
		return true;
	}

	// Führt eine administrative Aktion aus, sofern Admin-Rechte vorliegen
	async function verifyAdminAction(onSuccess) {
		if (!requireAdmin()) return;
		onSuccess();
	}

	// Hash generierung
	async function hashPassword(password) {
		const msgUint8 = new TextEncoder().encode(password);
		const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
	}

	// Verschlüsselung für Namen
	const CRYPTO_KEY = "dart_pro_2026_secure";
	function encryptName(text) {
		if (!text) return "";
		return btoa(text.split('').map((c, i) =>
			String.fromCharCode(c.charCodeAt(0) ^ CRYPTO_KEY.charCodeAt(i % CRYPTO_KEY.length))
		).join(''));
	}

	function decryptName(encoded) {
		if (!encoded) return "";
		try {
			const decoded = atob(encoded);
			return decoded.split('').map((c, i) =>
				String.fromCharCode(c.charCodeAt(0) ^ CRYPTO_KEY.charCodeAt(i % CRYPTO_KEY.length))
			).join('');
		} catch (e) { return "ERROR"; }
	}

	/**
	 * ============================================================
	 * 2. UI-SYSTEM (BENACHRICHTIGUNGEN & DIALOGE)
	 * ============================================================
	 */

	//Zeigt Info Meldungen am oberen Bildschirmrand an
	function showToast(message, type = 'primary') {
		const container = document.getElementById('toastContainer');
		const toast = document.createElement('div');
		toast.className = `toast toast-${type}`;
		toast.innerHTML = `<span>${message}</span>`;
		container.appendChild(toast);

		// Automatisch nach 3 Sekunden ausblenden und löschen
		setTimeout(() => {
			toast.style.animation = 'fadeOut 0.3s ease forwards';
			setTimeout(() => toast.remove(), 300);
		}, 3000);
	}

	// Zeigt ein Bestätigungs Fenser (für wichtige Aktionen)
	function showCustomDialog({ title, message, showCancel = true, confirmText = 'OK', cancelText = 'Abbrechen', onConfirm, customContent = null }) {
		const modal = document.getElementById('customDialog');
		document.getElementById('dialogTitle').textContent = title;
		document.getElementById('dialogMessage').textContent = message;
		const confirmBtn = document.getElementById('dialogConfirmBtn');
		const cancelBtn = document.getElementById('dialogCancelBtn');
		const customDiv = document.getElementById('dialogCustomContent');

		customDiv.innerHTML = '';
		if (customContent) customDiv.appendChild(customContent);

		// Beim Klicken auf Bestätigen: Funktion ausführen und Fenster schließen
		confirmBtn.textContent = confirmText;
		cancelBtn.textContent = cancelText;
		cancelBtn.style.display = showCancel ? 'block' : 'none';

		const close = () => modal.classList.remove('active');

		confirmBtn.onclick = () => { close(); if (onConfirm) onConfirm(); };
		cancelBtn.onclick = close;

		modal.classList.add('active');
	}

	/**
	 * ============================================================
	 * 3. DAS TOURNAMENT-MANAGER OBJEKT (Logik)
	 * ============================================================
	 */

	class TournamentManager {
		constructor(name, players, shouldShuffle, hasGroups = false) {
			this.name = name;
			// Vearbeitet die Spielerliste (Mischen und aufüllen mit Freilosen)
			this.players = this.processPlayers(players, shouldShuffle);
			this.winnerBracket = []; // Gewinner Baum
			this.loserBracket = []; // Verlierer Baum
			this.stepladder = []; // Top 3 Finale
			this.news = []; // Turnier News Feed
			this.hasGroups = hasGroups; // Ob Gruppenphase aktiviert ist
			this.groups = []; // Gruppen-Einteilung
			this.matchIdCounter = 0; // Eindeutige ID für jedes Match
			this.tournamentOver = false; // Ist das Turnier beendet
			this.wbToLbMap = {}; // Merkt sich welche Verlierer wohin im LB kommen
			this.initializeBrackets();
			if (this.hasGroups) {
				this.generateGroups();
			}
		}

		generateGroups(forceReshuffle = false) {
			if (!this.hasGroups) return;
			if (!forceReshuffle && this.groups && this.groups.length > 0) return;
			const realPlayers = this.players.filter(p => p.trim() && !TournamentManager.isBye(p));
			const groupTitles = ['Gruppe A', 'Gruppe B', 'Gruppe C', 'Gruppe D', 'Gruppe E', 'Gruppe F', 'Gruppe G', 'Gruppe H'];
			this.groups = groupTitles.map(title => ({ title, members: [], matches: [] }));

			// Zufälliges Mischen
			for (let i = realPlayers.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[realPlayers[i], realPlayers[j]] = [realPlayers[j], realPlayers[i]];
			}

			realPlayers.forEach((player, idx) => {
				this.groups[idx % this.groups.length].members.push(player);
			});

			// Generiere Jeder-gegen-Jeden Matches für jede Gruppe
			this.groups.forEach(group => {
				const m = group.members;
				for (let i = 0; i < m.length; i++) {
					for (let j = i + 1; j < m.length; j++) {
						group.matches.push(this.createMatch(0, m[i], m[j], 'group'));
					}
				}
			});
		}

		// Befüllt Gold und Bronze Runde aus den Gruppenergebnissen
		populateBracketsFromGroups() {
			if (!this.hasGroups || !this.groups || this.groups.length === 0) return;

			// Prüfen ob bereits befüllt
			if (this.winnerBracket[0] && this.winnerBracket[0].some(m => m.player1 || m.player2)) return;

			const rank1Players = [];
			const rank2Players = [];
			const rank3Players = [];
			const rank4Players = [];

			this.groups.forEach(group => {
				const standings = {};
				(group.members || []).forEach(m => {
					const mName = typeof m === 'string' ? m : m.name;
					standings[mName] = { name: mName, Pt: 0, plusPts: 0, lostPts: 0 };
				});

				(group.matches || []).forEach(match => {
					if (match.completed && !TournamentManager.isBye(match.player1) && !TournamentManager.isBye(match.player2)) {
						const p1 = match.player1;
						const p2 = match.player2;
						if (standings[p1]) {
							if (match.winner === p1) standings[p1].Pt += 1;
							standings[p1].plusPts += (match.score1 || 0);
							standings[p1].lostPts += (match.score2 || 0);
						}
						if (standings[p2]) {
							if (match.winner === p2) standings[p2].Pt += 1;
							standings[p2].plusPts += (match.score2 || 0);
							standings[p2].lostPts += (match.score1 || 0);
						}
					}
				});

				const sorted = Object.values(standings).sort((a, b) => {
					if (b.Pt !== a.Pt) return b.Pt - a.Pt;
					if (b.plusPts !== a.plusPts) return b.plusPts - a.plusPts;
					if (a.lostPts !== b.lostPts) return a.lostPts - b.lostPts;
					return a.name.localeCompare(b.name);
				});

				if (sorted[0]) rank1Players.push(sorted[0].name);
				if (sorted[1]) rank2Players.push(sorted[1].name);
				if (sorted[2]) rank3Players.push(sorted[2].name);
				if (sorted[3]) rank4Players.push(sorted[3].name);
			});

			// Mischt Array zufällig (Fisher-Yates)
			const shuffle = (arr) => {
				for (let i = arr.length - 1; i > 0; i--) {
					const j = Math.floor(Math.random() * (i + 1));
					[arr[i], arr[j]] = [arr[j], arr[i]];
				}
				return arr;
			};

			// Gold-Runde (Plätze 1 & 2): Zufällige Paarungen Rank1 vs Rank2 (niemals Rank1 vs Rank1)
			shuffle(rank1Players);
			shuffle(rank2Players);

			const goldMatches = [];
			for (let i = 0; i < rank1Players.length; i++) {
				// Pair rank1 with rank2
				const p1 = rank1Players[i];
				const p2 = rank2Players[i] || 'FREILOS';
				// Zufällige Seitenverteilung (wer Spieler 1 / Spieler 2 ist)
				if (Math.random() < 0.5) {
					goldMatches.push({ p1, p2 });
				} else {
					goldMatches.push({ p1: p2, p2: p1 });
				}
			}
			shuffle(goldMatches);

			// Gold Runde 1 neu aufbauen
			const goldRound1 = [];
			goldMatches.forEach(m => {
				goldRound1.push(this.createMatch(0, m.p1, m.p2, 'winner'));
			});
			// Falls auffüllen nötig für Zweierpotenz
			const targetGold = Math.pow(2, Math.ceil(Math.log2(goldRound1.length || 1)));
			while (goldRound1.length < targetGold) {
				goldRound1.push(this.createMatch(0, 'FREILOS', 'FREILOS', 'winner'));
			}

			this.winnerBracket = [goldRound1];
			this.createWBRounds();

			// Bronze-Runde (Plätze 3 & 4): Zufällige Paarungen Rank3 vs Rank4
			shuffle(rank3Players);
			shuffle(rank4Players);

			const bronzeMatches = [];
			const maxCount = Math.max(rank3Players.length, rank4Players.length);
			for (let i = 0; i < maxCount; i++) {
				const p1 = rank3Players[i] || 'FREILOS';
				const p2 = rank4Players[i] || 'FREILOS';
				if (Math.random() < 0.5) {
					bronzeMatches.push({ p1, p2 });
				} else {
					bronzeMatches.push({ p1: p2, p2: p1 });
				}
			}
			shuffle(bronzeMatches);

			const bronzeRound1 = [];
			bronzeMatches.forEach(m => {
				bronzeRound1.push(this.createMatch(0, m.p1, m.p2, 'loser'));
			});
			const targetBronze = Math.pow(2, Math.ceil(Math.log2(bronzeRound1.length || 1)));
			while (bronzeRound1.length < targetBronze) {
				bronzeRound1.push(this.createMatch(0, 'FREILOS', 'FREILOS', 'loser'));
			}

			this.loserBracket = [bronzeRound1];
			this.createLBRounds();

			this.checkAllByeMatches();
		}

		// Hilfsfunktion: Erkennt ob ein Platz ein Freilos ist
		static isBye(p) {
			if (!p) return false;
			const s = String(p).toUpperCase().trim();
			return s === 'BYE' || s === 'FREILOS';
		}

		// Bereitet die Spielerliste vor (2er-Potenz: 4,8,16,32 Spieler)
		processPlayers(players, shouldShuffle) {
			if (!shouldShuffle) {
				let res = [...players];
				const target = Math.pow(2, Math.ceil(Math.log2(res.length || 1)));
				while (res.length < target) res.push('FREILOS');
				return res;
			}
			// Zufälliges Mischen der Spieler
			let realPlayers = players.filter(p => p.trim() && !TournamentManager.isBye(p));
			// Mischt nur die echten Spieler (keine Freilose)
			for (let i = realPlayers.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[realPlayers[i], realPlayers[j]] = [realPlayers[j], realPlayers[i]];
			}

			const N = realPlayers.length;
			if (N <= 1) {
				const T = Math.pow(2, Math.ceil(Math.log2(N || 1)));
				let res = [...realPlayers];
				while (res.length < T) res.push('FREILOS');
				return res;
			}
			// Logik um Freilose fair in der ersten Runde aufzuteilen
			const T = Math.pow(2, Math.ceil(Math.log2(N)));
			const M = N - T / 2; // Real matches in WB Round 1

			const groupA = realPlayers.slice(0, 2 * M);
			const groupB = realPlayers.slice(2 * M);

			const result = [];
			// Gruppe A: Real vs Real. Verlierer kommen in das LB und die Gewinner gehen eins weiter
			for (let i = 0; i < groupA.length; i++) result.push(groupA[i]);
			// Gruppe B: Real vs FREILOS. Die Spieler mit einen Freilos gehen automatisch weiter und kein Spieler geht in das LB
			for (let i = 0; i < groupB.length; i++) {
				result.push(groupB[i]);
				result.push('FREILOS');
			}

			while (result.length < T) result.push('FREILOS');
			return result;
		}
		// Erstellt die Grundstruktur der Brackets (Runde1 bis Finale)
		initializeBrackets() {
			// Winner Bracket Runde 1 füllen
			const firstRound = [];
			const wbSlots = this.hasGroups ? Math.ceil(this.players.length / 2) : this.players.length;
			for (let i = 0; i < wbSlots; i += 2) {
				const p1 = this.hasGroups ? null : this.players[i];
				const p2 = this.hasGroups ? null : this.players[i + 1];
				firstRound.push(this.createMatch(0, p1, p2, 'winner'));
			}
			this.winnerBracket.push(firstRound);
			this.createWBRounds();

			// Loser bracket Logik
			let catA = [];
			firstRound.forEach((m, i) => {
				const p1b = TournamentManager.isBye(m.player1);
				const p2b = TournamentManager.isBye(m.player2);
				if (!p1b && !p2b) catA.push(i); // Nur Matches zwischen echten Spielern
			});

			// Optimierte LB-Größe: Nur so viele Plätze wie echte Verlierer nötig sind (Kategorie A)
			const numRealLosers = this.hasGroups ? Math.floor(this.players.length / 2) : catA.length;
			this.wbToLbMap = {};
			if (this.players.length > 4 && numRealLosers > 0) {
				// Kleinste Zweierpotenz um numRealLosers unterzubringen
				const lbSize = Math.max(1, Math.pow(2, Math.ceil(Math.log2(numRealLosers || 2)) - 1));
				const numByes = (lbSize * 2) - numRealLosers;

				// Zufällige Auswahl der Matches, die ein Freilos erhalten
				const matchIndices = Array.from({ length: lbSize }, (_, i) => i);
				for (let i = matchIndices.length - 1; i > 0; i--) {
					const j = Math.floor(Math.random() * (i + 1));
					[matchIndices[i], matchIndices[j]] = [matchIndices[j], matchIndices[i]];
				}
				const selectedByeIndices = new Set(matchIndices.slice(0, numByes));

				const lbRound0 = [];
				const availableSlots = [];
				for (let i = 0; i < lbSize; i++) {
					const hasBye = selectedByeIndices.has(i);
					lbRound0.push(this.createMatch(0, null, hasBye ? 'FREILOS' : null, 'loser'));

					// P1 ist immer für einen echten Verlierer verfügbar
					availableSlots.push({ lbIdx: i, isP1: true });
					// P2 ist nur verfügbar, wenn kein Freilos gesetzt wurde
					if (!hasBye) {
						availableSlots.push({ lbIdx: i, isP1: false });
					}
				}
				this.loserBracket = [lbRound0];

				// Zufälliges Mischen der verfügbaren Plätze für die WB-Verlierer
				for (let i = availableSlots.length - 1; i > 0; i--) {
					const j = Math.floor(Math.random() * (i + 1));
					[availableSlots[i], availableSlots[j]] = [availableSlots[j], availableSlots[i]];
				}

				// Mapping der Verlierer auf zufälligen Plätze (Freilose werde ignoriert)
				const wbIndices = this.hasGroups ? [] : catA;
				wbIndices.forEach((wbIdx, slotIdx) => {
					if (availableSlots[slotIdx]) {
						this.wbToLbMap[wbIdx] = availableSlots[slotIdx];
					}
				});

				this.createLBRounds();
			} else {
				this.loserBracket = [];
			}

			// Stepladder-Finale (Top3)
			this.stepladder = [
				{ id: 'step1', title: "Match 1: WB 3 vs SC 1", player1: null, player2: null, score1: 0, score2: 0, completed: false, type: 'stepladder' },
				{ id: 'step2', title: "Match 2: WB 2 vs SC 1", player1: null, player2: null, score1: 0, score2: 0, completed: false, type: 'stepladder' },
				{ id: 'step3', title: "FINALE: WB 1 vs SC 1", player1: null, player2: null, score1: 0, score2: 0, completed: false, type: 'stepladder' }
			];

			this.checkAllByeMatches();
		}

		// Prüft ob ein Match gegen ein Freilos stattfindet und packt den Sieger automatisch weiter
		checkAllByeMatches() {
			const processMatch = (m) => {
				if (m.completed && !m.winner && (TournamentManager.isBye(m.player1) || TournamentManager.isBye(m.player2))) {
					m.completed = false;
				}
				if (!m.completed && (TournamentManager.isBye(m.player1) || TournamentManager.isBye(m.player2))) {
					this.autoCompleteByeMatch(m);
				}
			};

			this.winnerBracket.forEach(round => round.forEach(processMatch));
			this.loserBracket.forEach(round => round.forEach(processMatch));
		}
		// schließt Freilos Matches automatisch ab
		autoCompleteByeMatch(m) {
			if (!m.player1 || !m.player2) return;

			const p1b = TournamentManager.isBye(m.player1);
			const p2b = TournamentManager.isBye(m.player2);

			if (p1b && p2b) {
				m.completed = true; m.winner = 'FREILOS'; m.loser = 'FREILOS';
			} else if (p1b) {
				m.winner = m.player2; m.loser = 'FREILOS'; m.completed = true;
			} else if (p2b) {
				m.winner = m.player1; m.loser = 'FREILOS'; m.completed = true;
			}
			if (m.completed) this.advanceWinner(m);
		}

		// Schickt den Sieger eines Matches in die nächste Runde
		advanceWinner(m) {
			if (m.type === 'winner') {
				const nextWB = this.winnerBracket[m.round + 1];
				if (nextWB) {
					const idx = Math.floor(this.winnerBracket[m.round].indexOf(m) / 2);
					if (this.winnerBracket[m.round].indexOf(m) % 2 === 0) nextWB[idx].player1 = m.winner; else nextWB[idx].player2 = m.winner;

					// Verlierer der 1 Runde werden ins Loser Bracket verschoben
					if (m.round === 0) {
						if (this.loserBracket.length > 0) {
							const mapping = this.wbToLbMap[this.winnerBracket[0].indexOf(m)];
							if (mapping) {
								const lbMatch = this.loserBracket[0][mapping.lbIdx];
								if (lbMatch) {
									if (mapping.isP1) lbMatch.player1 = m.loser; else lbMatch.player2 = m.loser;
								}
							}
						} else if (this.players.length <= 4) {
							if (!this.hasGroups) {
								if (!this.stepladder[0].player1) this.stepladder[0].player1 = m.loser; else this.stepladder[0].player2 = m.loser;
							}
						}
					}

					// Halbfinale Verlierer ins Spiel um Platz 3 (Winner Bracket) schieben
					if (m.round === this.winnerBracket.length - 2) {
						const lastRound = this.winnerBracket[this.winnerBracket.length - 1];
						const wb3Match = lastRound.find(match => match.type === 'winner_3rd');
						if (wb3Match) {
							if (!TournamentManager.isBye(m.loser)) {
								if (!wb3Match.player1) wb3Match.player1 = m.loser; else wb3Match.player2 = m.loser;
							} else {
								if (!wb3Match.player1) wb3Match.player1 = 'FREILOS'; else wb3Match.player2 = 'FREILOS';
							}
						}
					}
					this.checkAllByeMatches();
				} else {
					if (!this.hasGroups) {
						this.stepladder[2].player2 = m.winner;
						this.stepladder[1].player2 = m.loser;
						// Falls der Herausforderer bereits in Match 1 (step1) verloren hat und das Turnier auf ihn wartete
						if (this.stepladder[0].completed && this.stepladder[0].winner === this.stepladder[0].player2) {
							// Wenn  Platz 1 und 2 feststehen wird das Turnier beendet 
							if (this.stepladder[1].player2 && this.stepladder[2].player2) {
								this.tournamentOver = true;
							}
						}
					}
				}
			} else if (m.type === 'winner_3rd') {
				if (!this.hasGroups) {
					this.stepladder[0].player2 = m.winner;
					// Falls Match 1 bereits fertig ist und SC 1 verloren hat
					if (this.stepladder[0].completed && this.stepladder[0].winner === this.stepladder[0].player2) {
						if (this.stepladder[1].player2 && this.stepladder[2].player2) {
							this.tournamentOver = true;
						}
					}
				}
			}
			else if (m.type === 'loser') {
				const nextLR = this.loserBracket[m.round + 1];
				if (nextLR) {
					const idx = Math.floor(this.loserBracket[m.round].indexOf(m) / 2);
					const isP1 = this.loserBracket[m.round].indexOf(m) % 2 === 0;
					if (isP1) nextLR[idx].player1 = m.winner; else nextLR[idx].player2 = m.winner;
					this.checkAllByeMatches();
				} else {
					if (!this.hasGroups) {
						this.stepladder[0].player1 = m.winner;
					}
				}
			}
		}

		// Hilfsmethode um ein leeres Match Objekt zu erzeugen
		createMatch(round, p1, p2, type) {
			return { id: this.matchIdCounter++, round, player1: p1, player2: p2, score1: 0, score2: 0, completed: false, winner: null, loser: null, type };
		}

		// Baut die Gewinner Runden hierarchisch auf
		createWBRounds() {
			let r = 0;
			while (this.winnerBracket[r].length > 1) {
				const next = [];
				for (let i = 0; i < this.winnerBracket[r].length; i += 2) next.push(this.createMatch(r + 1, null, null, 'winner'));
				this.winnerBracket.push(next); r++;
			}
			if (this.players.length > 4) {
				const thirdPlaceMatch = this.createMatch(r, null, null, 'winner_3rd');
				this.winnerBracket[r].push(thirdPlaceMatch);
			}
		}

		// Baut die Verlierer-Runden hierarchisch auf
		createLBRounds() {
			let r = 0;
			while (this.loserBracket[r].length > 1) {
				const next = [];
				for (let i = 0; i < this.loserBracket[r].length; i += 2) next.push(this.createMatch(r + 1, null, null, 'loser'));
				this.loserBracket.push(next); r++;
			}
		}

		// Verwandelt rohe Daten aus der Datenbank wieder in ein Objekt 
		static fromJSON(data) {
			const t = new TournamentManager(data.name || "Turnier", [], false, data.hasGroups === true);
			Object.assign(t, data);
			t.hasGroups = data.hasGroups === true;
			const convert = (obj) => {
				if (!obj || Array.isArray(obj)) return obj || [];
				return Object.keys(obj).sort((a, b) => parseInt(a.split('_')[1]) - parseInt(b.split('_')[1])).map(k => obj[k]);
			};
			t.winnerBracket = convert(data.winnerBracket);
			t.loserBracket = convert(data.loserBracket);
			t.groups = data.groups || [];
			if (t.hasGroups && (!t.groups || t.groups.length === 0)) {
				t.generateGroups();
			}
			return t;
		}
	}

	/**
	 * ============================================================
	 * 4. AUTHENTIFIZIERUNG (LOGINS)
	 * ============================================================
	 */

	// User Login -> prüft ob der Hash übereinstimmt und setzt Admin-Status direkt aus DB
	async function authenticate(username, password) {
		if (!username || !password) return false;
		try {
			const { doc, getDoc } = window.dbFunctions;
			const ref = doc(window.db, CONFIG.USERS_COL, username);
			const snap = await getDoc(ref);
			if (snap.exists()) {
				const inputHash = await hashPassword(password);
				const dbPass = snap.data().password;
				if (dbPass === inputHash) {
					state.currentUser = { username, ...snap.data() };
					// Admin-Rolle prüfen
					state.isAdmin = snap.data().isAdmin === true;
					return true;
				}
			}
		} catch (e) { console.error(e); }
		return false;
	}

	/**
	 * ============================================================
	 * 5. UI-RENDERING (DIE DARSTELLUNG AUF DER SEITE)
	 * ============================================================
	 */

	// Aktualisiert die Liste der Teilnehmer
	function loadParticipants() {
		const list = document.getElementById('participantsList');
		if (!state.tournament) return;
		const t = state.tournament;
		const activePlayers = new Set();
		const allPlayers = new Set(t.players.filter(p => !TournamentManager.isBye(p)));

		// Prüft welche Teilnehmer noch in ein Bracket ist
		const checkMatch = (match) => {
			if (!match.completed) {
				if (match.player1 && !TournamentManager.isBye(match.player1)) activePlayers.add(match.player1);
				if (match.player2 && !TournamentManager.isBye(match.player2)) activePlayers.add(match.player2);
			}
		};
		t.winnerBracket.forEach(round => round.forEach(checkMatch));
		t.loserBracket.forEach(round => round.forEach(checkMatch));
		t.stepladder.forEach(checkMatch);

		// Während der Gruppenphase sind ALLE Spieler aktiv 
		if (t.hasGroups && t.groups && t.groups.length > 0) {
			const bracketHasPlayers = t.winnerBracket.some(round =>
				round.some(m => m.player1 || m.player2)
			);
			if (!bracketHasPlayers) {
				// Gruppenphase läuft → alle Spieler aus allen Gruppen sind aktiv
				t.groups.forEach(group => {
					(group.members || []).forEach(p => {
						if (p && !TournamentManager.isBye(p)) activePlayers.add(p);
					});
				});
				//  alle allPlayers-Spieler die keiner Gruppe zugeordnet sind hinzufügen
				allPlayers.forEach(p => activePlayers.add(p));
			}
		}

		list.innerHTML = '';
		const sorted = Array.from(allPlayers).sort((a, b) => {
			const aActive = activePlayers.has(a);
			const bActive = activePlayers.has(b);
			if (aActive && !bActive) return -1;
			if (!aActive && bActive) return 1;
			return a.localeCompare(b);
		});

		sorted.forEach(player => {
			const isActive = activePlayers.has(player);
			const div = document.createElement('div');
			div.className = `participant-item ${isActive ? 'active' : 'eliminated'}`;
			div.innerHTML = `<span>${player}</span><span class="participant-status ${isActive ? 'active' : 'eliminated'}">${isActive ? '✓ Im Turnier' : '✗ Ausgeschieden'}</span>`;
			list.appendChild(div);
		});
	}

	// Zeichnet alle UI-Elemente auf den aktuellen Zustand
	function updateUI() {
		const loginOverlay = document.getElementById('fullPageLogin');
		const mainApp = document.getElementById('mainAppContainer');
		// Login Screen anzeigen oder ausblenden
		if (state.currentUser) { loginOverlay.classList.add('hidden'); mainApp.classList.remove('hidden'); }
		else { loginOverlay.classList.remove('hidden'); mainApp.classList.add('hidden'); return; }

		const isAdmin = state.isAdmin;
		document.getElementById('adminBadge').textContent = isAdmin ? `👑 Admin (${state.currentUser.username})` : `👤 Zuschauer (${state.currentUser.username})`;

		// Admin Buttons (werden nur angezeigt wenn man ein Admin ist)
		document.getElementById('newTournamentBtn').classList.toggle('hidden', !isAdmin);
		document.getElementById('deleteTournamentBtn').classList.toggle('hidden', !isAdmin || !state.tournament);
		document.getElementById('userMgmtBtn').classList.toggle('hidden', !isAdmin);
		document.getElementById('adminLogoutBtn').classList.remove('hidden');
		document.getElementById('participantsBtn').classList.toggle('hidden', !state.tournament);

		// Wenn ein turnier geladen ist werden Brackets und News "gezeichnet"
		if (state.tournament) {
			document.getElementById('dashboardTitle').textContent = state.tournament.name;
			document.getElementById('tournamentSection').classList.remove('hidden');
			renderBracket('winnerBracket'); renderBracket('loserBracket'); renderStepladder(); renderNews();
			if (state.tournament.hasGroups) renderGroups();

			const groupsAdmin = document.getElementById('groupsAdminControls');
			if (groupsAdmin) groupsAdmin.classList.toggle('hidden', !isAdmin);

			// Gruppen-Tab Button anzeigen -> wenn Gruppenphase aktiviert ist
			const groupsTabBtn = document.querySelector('.tab-btn[data-tab="groupsSection"]');
			const wbTabBtn = document.querySelector('.tab-btn[data-tab="winnerBracket"]');
			const lbTabBtn = document.querySelector('.tab-btn[data-tab="loserBracket"]');
			const stepladderTabBtn = document.querySelector('.tab-btn[data-tab="stepladderBracket"]');

			const hasGroups = state.tournament.hasGroups === true;
			if (groupsTabBtn) {
				groupsTabBtn.classList.toggle('hidden', !hasGroups);
				if (!hasGroups && groupsTabBtn.classList.contains('active')) {
					groupsTabBtn.classList.remove('active');
					document.getElementById('groupsSection')?.classList.remove('active');
					const homeBtn = document.querySelector('.tab-btn[data-tab="homeSection"]');
					if (homeBtn) homeBtn.classList.add('active');
					document.getElementById('homeSection')?.classList.add('active');
				}
			}

			// Prüfen ob alle Gruppenspiele abgeschlossen sind
			let allGroupsCompleted = true;
			if (hasGroups && state.tournament.groups) {
				allGroupsCompleted = state.tournament.groups.length > 0 && state.tournament.groups.every(g =>
					g.matches && g.matches.length > 0 && g.matches.every(m => m.completed)
				);
			}

			// Gold- und Bronze-Runde ausblenden solange die Gruppenphase läuft
			const showBrackets = !hasGroups || allGroupsCompleted;

			if (wbTabBtn) {
				wbTabBtn.textContent = hasGroups ? '🥇 Gold Runde' : 'Winner Bracket';
				wbTabBtn.classList.toggle('hidden', !showBrackets);
				if (!showBrackets && wbTabBtn.classList.contains('active')) {
					wbTabBtn.classList.remove('active');
					document.getElementById('winnerBracket')?.classList.remove('active');
					const homeBtn = document.querySelector('.tab-btn[data-tab="homeSection"]');
					if (homeBtn) homeBtn.classList.add('active');
					document.getElementById('homeSection')?.classList.add('active');
				}
			}

			if (lbTabBtn) {
				lbTabBtn.textContent = hasGroups ? '🥉 Bronze Runde' : 'Second Chance';
				lbTabBtn.classList.toggle('hidden', !showBrackets);
				if (!showBrackets && lbTabBtn.classList.contains('active')) {
					lbTabBtn.classList.remove('active');
					document.getElementById('loserBracket')?.classList.remove('active');
					const homeBtn = document.querySelector('.tab-btn[data-tab="homeSection"]');
					if (homeBtn) homeBtn.classList.add('active');
					document.getElementById('homeSection')?.classList.add('active');
				}
			}

			if (stepladderTabBtn) {
				stepladderTabBtn.classList.toggle('hidden', hasGroups);
				if (hasGroups && stepladderTabBtn.classList.contains('active')) {
					stepladderTabBtn.classList.remove('active');
					document.getElementById('stepladderBracket')?.classList.remove('active');
					const homeBtn = document.querySelector('.tab-btn[data-tab="homeSection"]');
					if (homeBtn) homeBtn.classList.add('active');
					document.getElementById('homeSection')?.classList.add('active');
				}
			}

			// Falls das Gruppen-Modal aktiv ist, Ansicht automatisch neu rendern
			const groupModal = document.getElementById('groupDetailsModal');
			if (groupModal && groupModal.classList.contains('active') && state.currentGroupIndex !== null) {
				openGroupDetails(state.currentGroupIndex);
			}

			// Top 3 zeigen -> wenn das Turnier beendet wurde
			const rankingSec = document.getElementById('rankingSection');
			if (state.tournament.tournamentOver) {
				rankingSec.classList.remove('hidden');
				const pod = calculatePodium(state.tournament);
				document.getElementById('rank1').textContent = pod[0] || '-';
				document.getElementById('rank2').textContent = pod[1] || '-';
				document.getElementById('rank3').textContent = pod[2] || '-';
			} else {
				rankingSec.classList.add('hidden');
			}
		}

		// Aktualisiert die Info Knöpfe
		document.getElementById('rulesBtn').onclick = () => showInfoContent(state.globalAssets?.rules);
		document.getElementById('machineBtn').onclick = () => showInfoContent(state.globalAssets?.machine);

		// Anzeigen oder Verstecken der Bearbeitungs Knöpfe
		document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('hidden', !isAdmin));

		// Admin Registrierungs-Button im Dashboard 
		const regBtn = document.getElementById('registrationBtn');
		if (regBtn) regBtn.classList.toggle('hidden', !isAdmin);
	}

	// Lädt eine Userliste für die Adminverwaltung
	async function loadUsers(filter = '') {
		if (!requireAdmin()) return;
		const list = document.getElementById('userList');
		if (!filter) list.innerHTML = '<p style="text-align:center; padding:20px;">Lade Benutzer...</p>';
		try {
			const { collection, getDocs } = window.dbFunctions;
			const snap = await getDocs(collection(window.db, CONFIG.USERS_COL));
			list.innerHTML = '';

			const filteredDocs = snap.docs.filter(doc => doc.id.toLowerCase().includes(filter.toLowerCase()));

			if (filteredDocs.length === 0) {
				list.innerHTML = '<p style="text-align:center; padding:20px; color:var(--text-dim);">Keine Benutzer gefunden.</p>';
				return;
			}

			filteredDocs.forEach(doc => {
				const data = doc.data();
				const isUserAdmin = data.isAdmin === true;
				const isSelf = doc.id === state.currentUser?.username;
				const div = document.createElement('div');
				div.className = 'participant-item';
				div.innerHTML = `
                <div>
                    <b>${doc.id}</b>
                    ${isUserAdmin ? '<span style="margin-left:6px; font-size:0.7rem; background:rgba(99,102,241,0.2); color:var(--primary); padding:2px 7px; border-radius:20px; font-weight:700;">👑 Admin</span>' : ''}<br>
                    <small style="color:var(--text-dim)">PWT: ***********</small>
                </div>
                ${!isSelf ? `
                    <button class="btn btn-danger" onclick="deleteUser('${doc.id}')" style="padding:5px 10px; font-size:0.7rem;">Löschen</button>
                ` : '<small style="color:var(--primary)">Ich</small>'}
            `;
				list.appendChild(div);
			});
		} catch (e) {
			list.innerHTML = '<p style="color:var(--danger); text-align:center;">Fehler beim Laden.</p>';
			console.error(e);
		}
	}

	// Löscht einen benutzer aus der Datenbank
	window.deleteUser = (username) => {
		if (!requireAdmin()) return;
		showCustomDialog({
			title: "Benutzer löschen?",
			message: `Möchtest du '${username}' wirklich dauerhaft löschen?`,
			confirmText: "Löschen",
			onConfirm: async () => {
				try {
					await window.dbFunctions.deleteDoc(window.dbFunctions.doc(window.db, CONFIG.USERS_COL, username));
					showToast("Benutzer gelöscht", "success");
					loadUsers();
				} catch (e) {
					showToast("Fehler beim Löschen", "danger");
					console.error(e);
				}
			}
		});
	};

	// Berechnet Platz 1 bis 3 basierend auf dem Final-Status
	function calculatePodium(t) {
		if (t.hasGroups) {
			let r1 = '-', r2 = '-', r3 = '-';
			
			if (t.winnerBracket && t.winnerBracket.length > 0) {
				const finalRound = t.winnerBracket[t.winnerBracket.length - 1];
				const finalMatch = finalRound[0];
				if (finalMatch && finalMatch.completed) {
					r1 = finalMatch.winner;
					r2 = finalMatch.loser;
				}
			}
			
			if (t.loserBracket && t.loserBracket.length > 0) {
				const bronzeFinalRound = t.loserBracket[t.loserBracket.length - 1];
				const bronzeFinalMatch = bronzeFinalRound[0];
				if (bronzeFinalMatch && bronzeFinalMatch.completed) {
					r3 = bronzeFinalMatch.winner;
				}
			}
			
			return [r1, r2, r3];
		}

		const s = t.stepladder;
		let r1 = s[2].player2; // WB 1 Default
		let r2 = s[1].player2; // WB 2 Default
		let r3 = s[0].player2; // WB 3 Default

		if (s[2].completed) {
			r1 = s[2].winner;
			r2 = s[2].loser;
			r3 = s[1].loser;
		} else if (s[1].completed) {
			r1 = s[2].player2;
			r2 = s[1].winner;
			r3 = s[1].loser;
		} else if (s[0].completed) {
			r1 = s[2].player2;
			r2 = s[1].player2;
			r3 = s[0].winner;
		}
		return [r1, r2, r3];
	}

	// Zeigt Text oder Bilder in einem Vollbild Fenster an
	function showInfoContent(content) {
		if (!content) { showToast("Inhalt nicht verfügbar", "danger"); return; }
		const container = document.getElementById('imageModalContent');
		if (content && content.startsWith('data:image')) {
			container.innerHTML = `<img src="${content}" id="modalImage" alt="Vorschau">`;
		} else {
			container.innerHTML = `<div class="text-content-view">${content ? content.replace(/\n/g, '<br>') : ''}</div>`;
		}
		document.getElementById('imageModal').classList.add('active');
	}

	/**
	 * ============================================================
	 * 6. ASSET-UPLOAD (BILDER & REGEL-TEXTE)
	 * ============================================================
	 */

	window.triggerUpload = (type) => {
		if (!requireAdmin()) return;
		const wrapper = document.createElement('div');
		wrapper.style.display = 'flex';
		wrapper.style.gap = '10px';
		wrapper.style.marginTop = '15px';

		const btnImg = document.createElement('button');
		btnImg.className = 'btn btn-primary';
		btnImg.style.flex = '1';
		btnImg.textContent = '🖼️ BILD';

		const btnTxt = document.createElement('button');
		btnTxt.className = 'btn btn-outline';
		btnTxt.style.flex = '1';
		btnTxt.textContent = '📝 TEXT';

		wrapper.appendChild(btnImg);
		wrapper.appendChild(btnTxt);

		// Bild oder Text frage
		showCustomDialog({
			title: "Inhalt bearbeiten",
			message: "Möchtest du ein Bild hochladen oder einen Text eingeben?",
			showCancel: true,
			cancelText: "Abbrechen",
			confirmText: "", // Bestätigungs Button ausblenden
			customContent: wrapper
		});

		// Bestätigungs Button ausblenden für diesen Dialog
		document.getElementById('dialogConfirmBtn').style.display = 'none';

		btnImg.onclick = () => {
			document.getElementById('customDialog').classList.remove('active');
			document.getElementById('dialogConfirmBtn').style.display = 'block';
			document.getElementById(`${type}Upload`).click();
		};

		btnTxt.onclick = () => {
			document.getElementById('customDialog').classList.remove('active');
			document.getElementById('dialogConfirmBtn').style.display = 'block';
			const currentContent = state.globalAssets?.[type] || '';
			const isText = !currentContent.startsWith('data:image');

			const textInput = document.createElement('textarea');
			textInput.className = 'form-input';
			textInput.rows = 5;
			textInput.value = isText ? currentContent : '';

			// Text eingabe
			showCustomDialog({
				title: "Text eingeben",
				message: "Bearbeite den Text für diesen Bereich:",
				customContent: textInput,
				onConfirm: () => {
					if (!state.globalAssets) state.globalAssets = {};
					state.globalAssets[type] = textInput.value;
					saveAssetsToCloud();
					showToast("Text gespeichert!", "success");
				}
			});
		};
	};

	// Bild hochladen
	window.handleUpload = async (event, type) => {
		if (!requireAdmin()) return;
		const file = event.target.files[0];
		if (!file) return;

		const reader = new FileReader();
		reader.onload = async (e) => {
			const base64 = e.target.result;
			if (!state.globalAssets) state.globalAssets = {};
			state.globalAssets[type] = base64;
			await saveAssetsToCloud();
			showToast("Bild hochgeladen!", "success");
		};
		reader.readAsDataURL(file);
	};

	/**
	 * ============================================================
	 * 7. NEWS FEED SYSTEM
	 * ============================================================
	 */

	function renderNews() {
		const newsList = document.getElementById('newsFeedList');
		const adminPanel = document.getElementById('newsAdminPanel');
		if (!newsList) return;

		if (state.isAdmin) adminPanel.classList.remove('hidden');
		else adminPanel.classList.add('hidden');

		const news = state.tournament.news || [];
		// Sortiert die News (gepinnt zuerst und danach nach den Timestamp)
		const sortedNews = [...news].sort((a, b) => {
			if (a.pinned && !b.pinned) return -1;
			if (!a.pinned && b.pinned) return 1;
			return b.timestamp - a.timestamp;
		});

		// Schaut ob keine Nachrichten vorhanden sind
		if (sortedNews.length === 0) {
			newsList.innerHTML = '<p style="color: var(--text-dim); text-align: center; padding: 20px;">Keine Nachrichten vorhanden.</p>';
			return;
		}

		newsList.innerHTML = '';
		sortedNews.forEach(post => {
			const div = document.createElement('div');
			div.className = `news-item ${post.pinned ? 'pinned' : ''} ${post.system ? 'system' : ''}`;
			const date = new Date(post.timestamp).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

			div.innerHTML = `
            <div class="news-header">
                <div class="news-title-group">
                    <h4 class="news-title">${post.title || 'Nachricht'}</h4>
                    <span class="news-date">${post.pinned ? '📌 Gepinnt • ' : ''}${date}</span>
                </div>
                ${state.isAdmin ? `
                    <div class="news-actions">
                        <button onclick="pinNews('${post.id}')" class="news-btn" title="${post.pinned ? 'Entpinnen' : 'Pinnen'}">
                            ${post.pinned ? '✖️' : '📌'}
                        </button>
                        <button onclick="editNews('${post.id}')" class="news-btn" title="Bearbeiten">✏️</button>
                        <button onclick="deleteNews('${post.id}')" class="news-btn news-delete" title="Löschen">🗑️</button>
                    </div>
                ` : ''}
            </div>
            <div class="news-content">${post.content.replace(/\n/g, '<br>')}</div>
        `;
			newsList.appendChild(div);
		});
	}

	// News hinzufügen
	window.addNews = async () => {
		if (!requireAdmin()) return;
		const titleInput = document.getElementById('newsTitleInput');
		const contentInput = document.getElementById('newsInput');
		const title = titleInput.value.trim();
		const content = contentInput.value.trim();

		if (!content || !title) { showToast("Bitte Titel und Inhalt eingeben.", "danger"); return; }

		if (!state.tournament.news) state.tournament.news = [];
		const newPost = {
			id: 'news_' + Date.now(),
			title: title,
			content: content,
			timestamp: Date.now(),
			pinned: false
		};
		state.tournament.news.push(newPost);
		await saveToCloud();
		titleInput.value = '';
		contentInput.value = '';
	};

	// Automatischer Post für Match Ergebnisse
	window.addSystemNews = async (title, content, shouldSave = true) => {
		if (!state.tournament.news) state.tournament.news = [];
		const newPost = {
			id: 'news_' + Date.now(),
			title: title,
			content: content,
			timestamp: Date.now(),
			pinned: false,
			system: true
		};
		state.tournament.news.push(newPost);
		if (shouldSave) await saveToCloud();
	};

	// Posts löschen
	window.deleteNews = async (id) => {
		if (!requireAdmin()) return;
		showCustomDialog({
			title: "Löschen bestätigen",
			message: "Möchtest du diese Nachricht wirklich löschen?",
			confirmText: "Löschen",
			onConfirm: async () => {
				state.tournament.news = state.tournament.news.filter(n => n.id !== id);
				await saveToCloud();
				showToast("Nachricht gelöscht", "success");
			}
		});
	};

	// Posts pinnen oder entpinnen
	window.pinNews = async (id) => {
		if (!requireAdmin()) return;
		const post = state.tournament.news.find(n => n.id === id);
		if (post) post.pinned = !post.pinned;
		await saveToCloud();
	};

	// Posts bearbeiten
	window.editNews = async (id) => {
		if (!requireAdmin()) return;
		const post = state.tournament.news.find(n => n.id === id);
		if (!post) return;

		const wrapper = document.createElement('div');
		const titleIn = document.createElement('input');
		titleIn.className = 'form-input';
		titleIn.value = post.title || '';
		titleIn.placeholder = 'Titel';
		titleIn.style.marginBottom = '10px';

		const contentIn = document.createElement('textarea');
		contentIn.className = 'form-input';
		contentIn.value = post.content || '';
		contentIn.rows = 4;
		contentIn.placeholder = 'Inhalt';

		wrapper.appendChild(titleIn);
		wrapper.appendChild(contentIn);

		// Zeigt das Fenster zum bearbeiten an
		showCustomDialog({
			title: "Nachricht bearbeiten",
			customContent: wrapper,
			onConfirm: async () => {
				post.title = titleIn.value;
				post.content = contentIn.value;
				await saveToCloud();
				showToast("Nachricht aktualisiert", "success");
			}
		});
	};

	/**
	 * ============================================================
	 * 8. BRACKET ZEICHNEN (SVG-LINIEN)
	 * ============================================================
	 */

	// Zeichnet die Verbindungslinien zwischen den Matches
	function drawConnectors(svg, rounds, gradientId) {
		const containerRect = svg.parentElement.getBoundingClientRect();
		// Alle vorhandenen Pfade vorher entfernen, um Überlappungen zu vermeiden
		const existingPaths = svg.querySelectorAll('path');
		existingPaths.forEach(p => p.remove());
		for (let roundIndex = 0; roundIndex < rounds.length - 1; roundIndex++) {
			const currentRound = rounds[roundIndex];
			const nextRound = rounds[roundIndex + 1];
			for (let i = 0; i < currentRound.matches.length; i += 2) {
				if (i + 1 >= currentRound.matches.length) continue;
				const m1Node = currentRound.matches[i];
				const m2Node = currentRound.matches[i + 1];
				const nextNode = nextRound.matches[Math.floor(i / 2)];
				if (!m1Node || !m2Node || !nextNode) continue;

				const m1Hide = m1Node.classList.contains('match-pure-bye');
				const m2Hide = m2Node.classList.contains('match-pure-bye');
				if (m1Hide && m2Hide) continue;

				const r1 = m1Node.getBoundingClientRect();
				const r2 = m2Node.getBoundingClientRect();
				const rN = nextNode.getBoundingClientRect();

				const xRight = r1.right - containerRect.left;
				const xLeftNext = rN.left - containerRect.left;
				const xMid = (xRight + xLeftNext) / 2;

				const y1 = r1.top - containerRect.top + r1.height / 2;
				const y2 = r2.top - containerRect.top + r2.height / 2;
				const yN = rN.top - containerRect.top + rN.height / 2;

				const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
				path.setAttribute('class', 'bracket-line');
				if (document.body.classList.contains('bracket-modern') && gradientId) {
					path.style.stroke = `url(#${gradientId})`;
				}

				if (m1Hide) {
					path.setAttribute('d', `M ${xRight} ${y2} L ${xMid} ${y2} L ${xMid} ${yN} L ${xLeftNext} ${yN}`);
				} else if (m2Hide) {
					path.setAttribute('d', `M ${xRight} ${y1} L ${xMid} ${y1} L ${xMid} ${yN} L ${xLeftNext} ${yN}`);
				} else {
					const yMid = (y1 + y2) / 2;
					path.setAttribute('d',
						`M ${xRight} ${y1} L ${xMid} ${y1}` +
						` L ${xMid} ${y2}` +
						` L ${xRight} ${y2}` +
						` M ${xMid} ${yMid} L ${xLeftNext} ${yN}`
					);
				}
				svg.appendChild(path);

				if (nextRound.matches.length === 2 && roundIndex === rounds.length - 2) {
					const thirdNode = nextRound.matches[1];
					if (thirdNode) {
						const r3 = thirdNode.getBoundingClientRect();
						const y3 = r3.top - containerRect.top + r3.height / 2;
						const path3rd = document.createElementNS('http://www.w3.org/2000/svg', 'path');
						path3rd.setAttribute('class', 'bracket-line');
						if (document.body.classList.contains('bracket-modern') && gradientId) {
							path3rd.style.stroke = `url(#${gradientId})`;
						}
						let d;
						if (m1Hide) {
							d = `M ${xRight} ${y2} L ${xMid} ${y2} L ${xMid} ${y3} L ${xLeftNext} ${y3}`;
						} else if (m2Hide) {
							d = `M ${xRight} ${y1} L ${xMid} ${y1} L ${xMid} ${y3} L ${xLeftNext} ${y3}`;
						} else {
							const yMid2 = (y1 + y2) / 2;
							d = `M ${xRight} ${y1} L ${xMid} ${y1}` +
								` L ${xMid} ${y2}` +
								` L ${xRight} ${y2}` +
								` M ${xMid} ${yMid2} L ${xLeftNext} ${y3}`;
						}
						path3rd.setAttribute('d', d);
						svg.appendChild(path3rd);
					}
				}
			}
		}
	}

	/**
	 * ============================================================
	 * SETTINGS SYSTEM
	 * ============================================================
	 */

	const SETTINGS_KEY = 'dartTurnierSettings';
	const SETTINGS_DEFAULTS = {
		bracketStyle: 'classic',  // 'classic' | 'modern'
		accentColor: 'blue',     // 'blue' | 'purple' | 'green' | 'orange' | 'pink' | 'red' | 'cyan'
		compact: false,      // Kompakter Modus
		connectors: true,       // SVG-Verbindungslinien
		newsRefresh: false,      // News Autorefresh alle 30s
		showTileLabels: false     // Kachel-Beschriftung dauerhaft anzeigen
	};

	let appSettings = { ...SETTINGS_DEFAULTS };
	let newsRefreshInterval = null;

	// Lädt die Settings aus localStorage
	function loadSettings() {
		try {
			const saved = localStorage.getItem(SETTINGS_KEY);
			if (saved) appSettings = { ...SETTINGS_DEFAULTS, ...JSON.parse(saved) };
		} catch (e) {
			console.warn('Settings konnten nicht geladen werden:', e);
			appSettings = { ...SETTINGS_DEFAULTS };
		}
		applySettings();
	}

	// Speichert die Settings in localStorage
	function saveSettings() {
		try {
			localStorage.setItem(SETTINGS_KEY, JSON.stringify(appSettings));
		} catch (e) {
			console.warn('Settings konnten nicht gespeichert werden:', e);
		}
	}

	// Wendet alle Settings an
	function applySettings() {
		const body = document.body;

		// Bracket-Stil
		body.classList.toggle('bracket-modern', appSettings.bracketStyle === 'modern');

		// Akzentfarbe
		['blue', 'purple', 'green', 'orange', 'pink', 'red', 'cyan'].forEach(c => body.classList.remove(`accent-${c}`));
		if (appSettings.accentColor !== 'blue') body.classList.add(`accent-${appSettings.accentColor}`);

		// Kompakter Modus
		body.classList.toggle('compact-mode', appSettings.compact);

		// Verbindungslinien
		body.classList.toggle('no-connectors', !appSettings.connectors);

		// Kachel-Beschriftung dauerhaft anzeigen
		body.classList.toggle('show-tile-labels', appSettings.showTileLabels);

		// News Autorefresh
		if (newsRefreshInterval) { clearInterval(newsRefreshInterval); newsRefreshInterval = null; }
		if (appSettings.newsRefresh) {
			newsRefreshInterval = setInterval(() => { if (state.tournament) renderNews(); }, 30000);
		}
	}

	// Füllt das Settings-Modal mit den aktuellen Werten
	function openSettingsModal() {
		// Bracket-Stil
		const styleInput = document.querySelector(`input[name="bracketStyle"][value="${appSettings.bracketStyle}"]`);
		if (styleInput) styleInput.checked = true;

		// Akzentfarbe
		document.querySelectorAll('.color-swatch').forEach(btn => {
			btn.classList.toggle('active', btn.dataset.color === appSettings.accentColor);
		});

		// Toggles
		document.getElementById('settingCompact').checked = appSettings.compact;
		document.getElementById('settingConnectors').checked = appSettings.connectors;
		document.getElementById('settingNewsRefresh').checked = appSettings.newsRefresh;
		document.getElementById('settingTileLabels').checked = appSettings.showTileLabels;

		// Sidebar: immer auf ersten Reiter (Allgemein) zurücksetzen
		document.querySelectorAll('.settings-nav-item').forEach(b => b.classList.remove('active'));
		const firstNav = document.querySelector('.settings-nav-item[data-tab="allgemein"]');
		if (firstNav) firstNav.classList.add('active');
		document.querySelectorAll('.settings-tab-pane').forEach(p => p.classList.remove('active'));
		const firstPane = document.getElementById('settingsTab-allgemein');
		if (firstPane) firstPane.classList.add('active');

		document.getElementById('settingsModal').classList.add('active');
	}


	// Liest die Formular-Werte aus und wendet sie sofort an
	function applyAndSaveSettings() {
		// Bracket-Stil
		const styleSelected = document.querySelector('input[name="bracketStyle"]:checked');
		if (styleSelected) appSettings.bracketStyle = styleSelected.value;

		// Akzentfarbe
		const activeColor = document.querySelector('.color-swatch.active');
		if (activeColor) appSettings.accentColor = activeColor.dataset.color;

		// Toggles
		appSettings.compact = document.getElementById('settingCompact').checked;
		appSettings.connectors = document.getElementById('settingConnectors').checked;
		appSettings.newsRefresh = document.getElementById('settingNewsRefresh').checked;
		appSettings.showTileLabels = document.getElementById('settingTileLabels').checked;

		saveSettings();
		applySettings();

		// Brackets neu rendern -> wenn Turnier aktiv
		if (state.tournament) {
			renderBracket('winnerBracket');
			renderBracket('loserBracket');
			renderStepladder();
		}

		document.getElementById('settingsModal').classList.remove('active');
		showToast('✅ Einstellungen gespeichert', 'success');
	}

	// Setzt alle Settings auf Standardwerte zurück
	function resetSettings() {
		appSettings = { ...SETTINGS_DEFAULTS };
		saveSettings();
		openSettingsModal(); // Modal neu befüllen
		applySettings();
		if (state.tournament) {
			renderBracket('winnerBracket');
			renderBracket('loserBracket');
			renderStepladder();
		}
		showToast('↺ Einstellungen zurückgesetzt', 'primary');
	}

	// Uhrzeit formatieren
	function formatTime(timeStr) {
		return timeStr;
	}

	function getScheduledGameInfo(player1, player2) {
		if (!player1 || !player2 || !state.plannedGames || state.plannedGames.length === 0) return null;
		const title1 = `${player1} vs. ${player2}`;
		const title2 = `${player2} vs. ${player1}`;
		const game = state.plannedGames.find(g => g.title.startsWith(title1) || g.title.startsWith(title2));
		if (!game) return null;
		const dateObj = new Date(game.date);
		const formattedDate = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(dateObj);
		return `📅 ${formattedDate}, ${formatTime(game.time)} Uhr`;
	}

	// Generiert das visuelle HTML für Winner- und Loser Bracket
	function renderBracket(type) {
		const container = document.querySelector(`#${type} .bracket-scroll`);
		if (!container) return; container.innerHTML = '';
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('class', 'bracket-connector');
		Object.assign(svg.style, { position: 'absolute', top: '0', left: '0', width: '100%', height: '100%' });

		const gradientId = 'bracketGradient_' + type;
		if (document.body.classList.contains('bracket-modern')) {
			const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
			defs.innerHTML = `
				<linearGradient id="${gradientId}" x1="0%" y1="0%" x2="100%" y2="0%">
					<stop offset="0%"   stop-color="var(--primary)" stop-opacity="0.8"/>
					<stop offset="100%" stop-color="rgba(139,92,246,0.5)"/>
				</linearGradient>`;
			svg.appendChild(defs);
		}

		container.appendChild(svg);
		const rounds = [];
		state.tournament[type].forEach((round, rI) => {
			const isFinalRound = rI === state.tournament[type].length - 1;
			const col = document.createElement('div'); col.className = 'bracket-round';
			col.innerHTML = `<div class="badge" style="margin-bottom:15px; text-align:center">${isFinalRound ? (type === 'winnerBracket' ? "Finale & Platz 3" : "SC Finale") : `Runde ${rI + 1}`}</div>`;
			const matchesContainer = document.createElement('div'); matchesContainer.className = 'bracket-matches-container';
			const matchElements = [];
			round.forEach((m) => {
				const groupDiv = document.createElement('div'); groupDiv.className = 'match-group';
				let titleHtml = '';
				if (type === 'winnerBracket') {
					if (m.type === 'winner_3rd') titleHtml = `<div class="match-title bronze">🥉 Spiel um Platz 3</div>`;
					else if (isFinalRound && m.type === 'winner') titleHtml = `<div class="match-title">🏆 Spiel um Platz 1</div>`;
				}
				const div = document.createElement('div');
				const isP1B = TournamentManager.isBye(m.player1);
				const isP2B = TournamentManager.isBye(m.player2);
				const isPureBye = isP1B && isP2B;
				div.className = `match ${m.completed ? 'completed' : ''} ${isPureBye ? 'match-pure-bye' : ''}`;
				div.innerHTML = `${titleHtml}
                <div class="match-player ${m.winner === m.player1 && m.completed ? 'winner' : (m.loser === m.player1 && m.completed ? 'loser' : '')}"><span>${m.player1 || 'TBD'}</span><span class="match-score">${m.score1 === 0 && m.score2 === 0 && m.completed && isP1B ? '' : m.score1}</span></div>
                <div class="match-vs">vs</div>
                <div class="match-player ${m.winner === m.player2 && m.completed ? 'winner' : (m.loser === m.player2 && m.completed ? 'loser' : '')}"><span>${m.player2 || 'TBD'}</span><span class="match-score">${m.score1 === 0 && m.score2 === 0 && m.completed && isP2B ? '' : m.score2}</span></div>`;
				if (state.isAdmin && m.player1 && m.player2 && !isP1B && !isP2B) div.onclick = () => openMatch(m);
				// Spielzeit aus dem Kalender anzeigen (immer reservierter Container für konsistente Kachelhöhe)
				const scheduleInfo = (!isPureBye && m.player1 && m.player2 && !isP1B && !isP2B) ? getScheduledGameInfo(m.player1, m.player2) : null;
				const schedDiv = document.createElement('div');
				if (!m.completed && !isPureBye && m.player1 && m.player2 && !isP1B && !isP2B) {
					schedDiv.className = 'match-schedule' + (scheduleInfo ? '' : ' not-scheduled');
					schedDiv.textContent = scheduleInfo || '⏳ Noch nicht geplant';
				} else {
					// Reservierter unsichtbarer Platzhalter bei abgeschlossenen Matches, damit die Höhe exakt gleich bleibt
					schedDiv.className = 'match-schedule placeholder';
					schedDiv.style.visibility = 'hidden';
					schedDiv.textContent = '⏳ Placeholder';
				}
				div.appendChild(schedDiv);

				groupDiv.appendChild(div); matchesContainer.appendChild(groupDiv); matchElements.push(div);
			});
			col.appendChild(matchesContainer); container.appendChild(col); rounds.push({ col, matches: matchElements });
		});
		setTimeout(() => drawConnectors(svg, rounds, gradientId), 50);
		setTimeout(() => drawConnectors(svg, rounds, gradientId), 300);
	}

	// Generiert das visuelle HTML für das Stepladder Finale
	function renderStepladder() {
		const container = document.querySelector('#stepladderBracket .bracket-scroll');
		if (!container) return; container.innerHTML = '';
		state.tournament.stepladder.forEach(m => {
			const div = document.createElement('div'); div.className = `match ${m.completed ? 'completed' : ''}`;
			div.style.minWidth = "320px";
			div.innerHTML = `<div style="font-size:0.7rem; color:var(--primary); margin-bottom:5px; font-weight:bold;">${m.title}</div>
            <div class="match-player ${m.winner === m.player1 && m.completed ? 'winner' : (m.loser === m.player1 && m.completed ? 'loser' : '')}"><span>${m.player1 || 'TBD'}</span><span class="match-score">${m.score1}</span></div>
            <div class="match-vs">vs</div>
            <div class="match-player ${m.winner === m.player2 && m.completed ? 'winner' : (m.loser === m.player2 && m.completed ? 'loser' : '')}"><span>${m.player2 || 'TBD'}</span><span class="match-score">${m.score2}</span></div>`;
			// Spielzeit aus dem Kalender anzeigen (nur wenn nicht abgeschlossen)
			if (!m.completed && m.player1 && m.player2) {
				const scheduleInfo = getScheduledGameInfo(m.player1, m.player2);
				const schedDiv = document.createElement('div');
				schedDiv.className = 'match-schedule' + (scheduleInfo ? '' : ' not-scheduled');
				schedDiv.textContent = scheduleInfo || '⏳ Noch nicht geplant';
				div.appendChild(schedDiv);
			}
			if (state.isAdmin && m.player1 && m.player2) div.onclick = () => openMatch(m);
			container.appendChild(div);
		});
	}

	// Generiert das visuelle HTML für die Gruppen-Übersicht
	function renderGroups() {
		const container = document.getElementById('groupsContainer');
		if (!container) return;
		container.innerHTML = '';

		if (!state.tournament) {
			container.innerHTML = '<p style="color: var(--text-dim); text-align: center; grid-column: 1 / -1; padding: 40px;">Kein aktives Turnier.</p>';
			return;
		}

		const t = state.tournament;
		if (!t.groups || t.groups.length === 0) {
			if (typeof t.generateGroups === 'function') {
				t.generateGroups();
			} else {
				const realPlayers = (t.players || []).filter(p => p.trim() && !TournamentManager.isBye(p));
				const groupTitles = ['Gruppe A', 'Gruppe B', 'Gruppe C', 'Gruppe D', 'Gruppe E', 'Gruppe F', 'Gruppe G', 'Gruppe H'];
				t.groups = groupTitles.map(title => ({ title, members: [] }));
				realPlayers.forEach((player, idx) => {
					t.groups[idx % t.groups.length].members.push(player);
				});
			}
		}

		t.groups.forEach((group, index) => {
			const allCompleted = group.matches && group.matches.length > 0 && group.matches.every(m => m.completed);
			const card = document.createElement('div');
			card.className = 'group-card glass' + (allCompleted ? ' completed' : '');

			const header = document.createElement('div');
			header.className = 'group-header';
			header.innerHTML = `
				<span class="group-title">${group.title || `Gruppe ${index + 1}`} ${allCompleted ? '<span style="color: var(--success); margin-left: 6px;">✓</span>' : ''}</span>
				<span class="group-badge" style="${allCompleted ? 'border-color: var(--success); color: var(--success);' : ''}">${allCompleted ? 'Beendet' : `${group.members ? group.members.length : 0} ${group.members && group.members.length === 1 ? 'Mitglied' : 'Mitglieder'}`}</span>
			`;

			const body = document.createElement('div');
			body.className = 'group-body';

			if (group.members && group.members.length > 0) {
				const standings = {};
				group.members.forEach(m => {
					const mName = typeof m === 'string' ? m : m.name;
					standings[mName] = { name: mName, Pt: 0, W: 0, plusPts: 0, lostPts: 0 };
				});

				(group.matches || []).forEach(match => {
					if (match.completed && !TournamentManager.isBye(match.player1) && !TournamentManager.isBye(match.player2)) {
						const p1 = match.player1;
						const p2 = match.player2;
						if (standings[p1] !== undefined) {
							if (match.winner === p1) {
								standings[p1].Pt += 1;
								standings[p1].W += 1;
							}
							standings[p1].plusPts += (match.score1 || 0);
							standings[p1].lostPts += (match.score2 || 0);
						}
						if (standings[p2] !== undefined) {
							if (match.winner === p2) {
								standings[p2].Pt += 1;
								standings[p2].W += 1;
							}
							standings[p2].plusPts += (match.score2 || 0);
							standings[p2].lostPts += (match.score1 || 0);
						}
					}
				});

				const sortedMembers = group.members.map(m => {
					const mName = typeof m === 'string' ? m : m.name;
					const st = standings[mName] || { Pt: 0, W: 0, plusPts: 0, lostPts: 0 };
					return { name: mName, points: st.Pt, wins: st.W, plusPts: st.plusPts, lostPts: st.lostPts };
				}).sort((a, b) => {
					if (b.points !== a.points) return b.points - a.points;
					// Tiebreaker 1: Mehr Plus-Punkte (gesamt erzielte Punkte)
					if (b.plusPts !== a.plusPts) return b.plusPts - a.plusPts;
					// Tiebreaker 2: Weniger Verlier-Punkte (kassierten Punkte)
					if (a.lostPts !== b.lostPts) return a.lostPts - b.lostPts;
					return a.name.localeCompare(b.name);
				});

				sortedMembers.forEach((member, idx) => {
					const prev = sortedMembers[idx - 1];
					const next = sortedMembers[idx + 1];
					const isTiedWithPrev = prev && prev.points === member.points;
					const isTiedWithNext = next && next.points === member.points;
					const isLegDecided = isTiedWithPrev || isTiedWithNext;

					const pointsColor = isLegDecided ? 'var(--text-main)' : 'var(--success)';
					const legsColor = isLegDecided ? 'var(--success)' : 'var(--text-dim)';

					const memberName = member.name;
					const item = document.createElement('div');
					item.className = 'group-member-item';
					item.innerHTML = `
						<div class="group-member-info" style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
							<div>
								<span class="member-name">${memberName}</span>
							</div>
							<div class="member-points" style="font-weight: bold; font-size: 0.85rem;">
								<span style="color: ${pointsColor};">${member.points} Pkt.</span>
								<span style="color: ${legsColor}; margin-left: 6px; font-size: 0.75rem;">(${member.plusPts}:${member.lostPts} Legs)</span>
							</div>
						</div>
					`;
					body.appendChild(item);
				});
			} else {
				const empty = document.createElement('div');
				empty.className = 'group-empty';
				empty.textContent = 'Mitglieder';
				body.appendChild(empty);
			}

			card.style.cursor = 'pointer';
			card.onclick = () => openGroupDetails(index);
			card.appendChild(header);
			card.appendChild(body);
			container.appendChild(card);
		});
	}

	function openGroupDetails(groupIndex) {
		const t = state.tournament;
		if (!t || !t.groups || !t.groups[groupIndex]) return;
		state.currentGroupIndex = groupIndex;
		const group = t.groups[groupIndex];

		document.getElementById('groupDetailsTitle').textContent = `GRUPPENPHASE - ${group.title || `GRUPPE ${groupIndex + 1}`}`;

		// Platz berechnen
		const standings = {};
		group.members.forEach(m => {
			const mName = typeof m === 'string' ? m : m.name;
			standings[mName] = { name: mName, G: 0, W: 0, L: 0, Pt: 0, plusPts: 0, lostPts: 0 };
		});

		(group.matches || []).forEach(match => {
			if (match.completed && !TournamentManager.isBye(match.player1) && !TournamentManager.isBye(match.player2)) {
				const p1 = match.player1;
				const p2 = match.player2;
				if (!standings[p1]) standings[p1] = { name: p1, G: 0, W: 0, L: 0, Pt: 0, plusPts: 0, lostPts: 0 };
				if (!standings[p2]) standings[p2] = { name: p2, G: 0, W: 0, L: 0, Pt: 0, plusPts: 0, lostPts: 0 };

				standings[p1].G++;
				standings[p2].G++;

				if (match.winner === p1) {
					standings[p1].W++;
					standings[p1].Pt += 1;
					standings[p2].L++;
				} else if (match.winner === p2) {
					standings[p2].W++;
					standings[p2].Pt += 1;
					standings[p1].L++;
				}
				// Plus-Punkte und Verlier-Punkte für alle Spiele akkumulieren
				standings[p1].plusPts += (match.score1 || 0);
				standings[p1].lostPts += (match.score2 || 0);
				standings[p2].plusPts += (match.score2 || 0);
				standings[p2].lostPts += (match.score1 || 0);
			}
		});

		const standingArray = Object.values(standings).sort((a, b) => {
			if (b.Pt !== a.Pt) return b.Pt - a.Pt;
			// Tiebreaker 1: Mehr Plus-Punkte (gesamt erzielte Punkte)
			if (b.plusPts !== a.plusPts) return b.plusPts - a.plusPts;
			// Tiebreaker 2: Weniger Verlier-Punkte (kassierten Punkte)
			if (a.lostPts !== b.lostPts) return a.lostPts - b.lostPts;
			return a.name.localeCompare(b.name);
		});

		// Bestimme für jeden Spieler, worauf die Platzierung im Vergleich zu den Nachbarn basiert
		standingArray.forEach((s, idx) => {
			s.decidedBy = 'Pt'; // Standardmäßig durch Punkte entschieden

			// Prüfe den Vergleich mit dem Vorgänger oder Nachfolger bei Punktgleichheit
			const prev = standingArray[idx - 1];
			const next = standingArray[idx + 1];

			const tiedWithPrev = prev && prev.Pt === s.Pt;
			const tiedWithNext = next && next.Pt === s.Pt;

			if (tiedWithPrev || tiedWithNext) {
				// Wenn Punktgleichheit besteht, entschied die Leg-Differenz bzw. Leg-Punkte den Platz
				s.decidedBy = 'Legs';
			}
		});

		// Punkte updaten
		group.members = group.members.map(m => {
			const mName = typeof m === 'string' ? m : m.name;
			const pts = standings[mName] ? standings[mName].Pt : 0;
			return { name: mName, points: pts };
		});

		const tbody = document.getElementById('groupStandingsBody');
		tbody.innerHTML = '';
		standingArray.forEach((s, idx) => {
			const tr = document.createElement('tr');
			const ptStyle = s.decidedBy === 'Pt' ? 'color: var(--success); font-weight: bold;' : '';
			const legsStyle = s.decidedBy === 'Legs' ? 'color: var(--success); font-weight: bold;' : '';

			tr.innerHTML = `
				<td>${idx + 1}</td>
				<td>
					<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--text-dim);margin-right:8px;"></span>
					${s.name}
				</td>
				<td style="text-align: center;">${s.G}</td>
				<td style="text-align: center;">${s.W}</td>
				<td style="text-align: center;">${s.L}</td>
				<td style="text-align: center; ${ptStyle}">${s.Pt}</td>
				<td style="text-align: center; ${legsStyle}">${s.plusPts}:${s.lostPts}</td>
			`;
			tbody.appendChild(tr);
		});

		const matchesList = document.getElementById('groupMatchesList');
		matchesList.innerHTML = '';
		(group.matches || []).forEach((match, mIdx) => {
			const row = document.createElement('div');
			row.className = 'group-match-row ' + (state.isAdmin ? 'admin-clickable' : '');

			let scoreText = match.completed ? `${match.score1}:${match.score2}` : '-:-';

			let p1Class = 'gm-player';
			let p2Class = 'gm-player';

			if (match.completed) {
				if (match.winner === match.player1) {
					p1Class += ' winner';
					p2Class += ' loser';
				} else if (match.winner === match.player2) {
					p2Class += ' winner';
					p1Class += ' loser';
				}
			}

			let scheduleHtml = '';
			if (!match.completed && match.player1 && match.player2) {
				const scheduleInfo = getScheduledGameInfo(match.player1, match.player2);
				if (scheduleInfo) {
					scheduleHtml = `<div class="group-match-schedule" style="grid-column: 1 / -1; text-align: center; font-size: 0.7rem; color: var(--primary); margin-top: 5px; font-weight: bold; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 5px;">${scheduleInfo}</div>`;
				} else {
					scheduleHtml = `<div class="group-match-schedule not-scheduled" style="grid-column: 1 / -1; text-align: center; font-size: 0.7rem; color: var(--text-dim); opacity: 0.5; margin-top: 5px; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 5px;">⏳ Noch nicht geplant</div>`;
				}
			}

			row.innerHTML = `
				<div style="font-size:1.1rem;font-weight:bold;color:var(--text-dim);text-align:center;">${mIdx + 1}</div>
				<div class="${p1Class}" style="justify-content: flex-end;">${match.player1}</div>
				<div style="text-align: center; color: var(--text-dim); font-size: 0.8rem;">VS</div>
				<div class="${p2Class}">${match.player2}</div>
				<div class="gm-score">${scoreText}</div>
				${scheduleHtml}
			`;

			if (state.isAdmin) {
				row.onclick = () => {
					match.groupIndex = groupIndex; // Attach group index for handleResult
					openMatch(match);
				};
			}
			matchesList.appendChild(row);
		});

		document.getElementById('groupDetailsModal').classList.add('active');
	}

	// Rendert Gruppen für archiviertes Turnier
	function renderArchivedGroups(tournament, container) {
		if (!container) return;
		container.innerHTML = '';
		let groups = tournament.groups;
		if (!groups || groups.length === 0) {
			const realPlayers = (tournament.players || []).filter(p => p.trim() && !TournamentManager.isBye(p));
			const groupTitles = ['Gruppe A', 'Gruppe B', 'Gruppe C', 'Gruppe D', 'Gruppe E', 'Gruppe F', 'Gruppe G', 'Gruppe H'];
			groups = groupTitles.map(title => ({ title, members: [] }));
			realPlayers.forEach((player, idx) => {
				groups[idx % groups.length].members.push(player);
			});
		}

		groups.forEach((group, index) => {
			const card = document.createElement('div');
			card.className = 'group-card glass';

			const header = document.createElement('div');
			header.className = 'group-header';
			header.innerHTML = `
				<span class="group-title">${group.title || `Gruppe ${index + 1}`}</span>
				<span class="group-badge">${group.members ? group.members.length : 0} ${group.members && group.members.length === 1 ? 'Mitglied' : 'Mitglieder'}</span>
			`;

			const body = document.createElement('div');
			body.className = 'group-body';

			if (group.members && group.members.length > 0) {
				group.members.forEach(member => {
					const item = document.createElement('div');
					item.className = 'group-member-item';
					item.innerHTML = `
						<div class="group-member-info">
							<span class="member-icon">🎯</span>
							<span class="member-name">${member}</span>
						</div>
					`;
					body.appendChild(item);
				});
			} else {
				const empty = document.createElement('div');
				empty.className = 'group-empty';
				empty.textContent = 'Mitglieder';
				body.appendChild(empty);
			}

			card.appendChild(header);
			card.appendChild(body);
			container.appendChild(card);
		});
	}

	/**
	 * ============================================================
	 * 9. ERGEBNIS-EINGABE & SPEICHERN
	 * ============================================================
	 */


	// Öffnet das Eingabefenster für einen Punktestand
	function openMatch(m) {
		if (!requireAdmin()) return;
		state.editingMatch = m;
		document.getElementById('matchModalContent').innerHTML = `<div style="margin-bottom:15px"><label>${m.player1}</label><input type="number" id="sc1" class="form-input" value="${m.score1}"></div><div><label>${m.player2}</label><input type="number" id="sc2" class="form-input" value="${m.score2}"></div>`;
		document.getElementById('matchModal').classList.add('active');
	}

	// Vearbeitet das eingetragene Ergebnis und rückt Spieler vor
	async function handleResult() {
		if (!requireAdmin()) return;
		const m = state.editingMatch;
		const t = state.tournament;
		if (!m || !t) return;

		m.score1 = parseInt(document.getElementById('sc1').value) || 0;
		m.score2 = parseInt(document.getElementById('sc2').value) || 0;
		m.completed = true;
		m.winner = m.score1 > m.score2 ? m.player1 : m.player2;
		m.loser = m.score1 > m.score2 ? m.player2 : m.player1;

		try {
			if (m.type === 'winner' || m.type === 'winner_3rd' || m.type === 'loser') {
				t.advanceWinner(m);
			} else if (m.type === 'group') {
				// Gruppenübersicht auf der Hauptseite aktualisieren
				renderGroups();
				// Re-render group details directly falls offen.
				if (m.groupIndex !== undefined) {
					openGroupDetails(m.groupIndex);
				}

				// Prüfen ob alle Gruppenspiele beendet sind -> Falls ja: Brackets aus Gruppenergebnissen befüllen
				const allCompleted = t.groups && t.groups.length > 0 && t.groups.every(g =>
					g.matches && g.matches.length > 0 && g.matches.every(match => match.completed)
				);
				if (allCompleted) {
					t.populateBracketsFromGroups();
				}
			} else if (m.type === 'stepladder') {
				if (m.id === 'step1') {
					if (m.winner === m.player1) {
						t.stepladder[1].player1 = m.winner;
					} else {
						// Turnier nur beenden, wenn Platz 1 und 2 bereits feststehen
						if (t.stepladder[1].player2 && t.stepladder[2].player2) {
							t.tournamentOver = true;
						} else {
							showToast("Turnier wartet auf WB Ergebnisse für Platz 1 & 2", "primary");
						}
					}
				} else if (m.id === 'step2') {
					if (m.winner === m.player1) {
						t.stepladder[2].player1 = m.winner;
					} else {
						// Turnier nur beenden, wenn Platz 1 bereits feststeht
						if (t.stepladder[2].player2) {
							t.tournamentOver = true;
						} else {
							showToast("Turnier wartet auf WB Ergebnis für Platz 1", "primary");
						}
					}
				} else if (m.id === 'step3') {
					t.tournamentOver = true;
				}
			}

			if (t.hasGroups) {
				const goldFinished = t.winnerBracket.length > 0 && t.winnerBracket.every(round => round.every(match => match.completed));
				const bronzeFinished = t.loserBracket.length > 0 && t.loserBracket.every(round => round.every(match => match.completed));
				
				if (goldFinished && bronzeFinished) {
					t.tournamentOver = true;
				}
			}

			// News Feed Nachricht ertsllen
			let matchTitle = m.title;
			if (!matchTitle) {
				if (m.type === 'winner') {
					const isFinal = m.round === t.winnerBracket.length - 1;
					matchTitle = isFinal ? "🏆 WB FINALE" : `Winner Bracket - Runde ${m.round + 1}`;
				} else if (m.type === 'winner_3rd') {
					matchTitle = "🥉 Spiel um Platz 3 (WB)";
				} else if (m.type === 'loser') {
					matchTitle = `Second Chance - Runde ${m.round + 1}`;
				} else if (m.type === 'group') {
					let foundGroup = null;
					if (m.groupIndex !== undefined && t.groups[m.groupIndex]) {
						foundGroup = t.groups[m.groupIndex];
					} else {
						foundGroup = t.groups.find(g => g.matches && g.matches.some(match => match.id === m.id));
					}
					matchTitle = foundGroup ? foundGroup.title : "Gruppenspiel";
				} else {
					matchTitle = "Match";
				}
			}

			const p1Class = m.winner === m.player1 ? 'winner-text' : '';
			const p2Class = m.winner === m.player2 ? 'winner-text' : '';
			await addSystemNews(`Match Ergebnis: ${matchTitle}`, `🎯 <b class="${p1Class}">${m.player1}</b> ${m.score1} : ${m.score2} <b class="${p2Class}">${m.player2}</b><br>🏆 Sieger: <b class="winner-text">${m.winner}</b>`, false);

			if (t.tournamentOver) {
				const pod = calculatePodium(t);
				await addSystemNews(`🎊 TURNIER BEENDET 🎊`, `👑 <b>1. Platz: ${pod[0]}</b><br>🥈 2. Platz: ${pod[1]}<br>🥉 3. Platz: ${pod[2]}<br><br>Herzlichen Glückwunsch an alle Teilnehmer!`, false);

				// Auto-Archivierung -> Turnier wird archivieren wenn es beendet ist
				await saveToCloud(); // speichern
				await archiveTournament(); // archivieren
				return;
			}


			// Automatische Löschung des geplanten Spiels aus dem Kalender -> wenn das Ergebnis eingetragen wurde
			if (state.plannedGames && state.plannedGames.length > 0) {
				const plannedMatch = state.plannedGames.find(g =>
					g.title.startsWith(`${m.player1} vs. ${m.player2}`) ||
					g.title.startsWith(`${m.player2} vs. ${m.player1}`)
				);
				if (plannedMatch) {
					const { doc, deleteDoc } = window.dbFunctions;
					await deleteDoc(doc(window.db, CONFIG.GAMES_COL, plannedMatch.id)).catch(err => console.error("Auto-delete failed:", err));
				}
			}

			await saveToCloud();
			updateUI();
		} finally {
			document.getElementById('matchModal').classList.remove('active');
		}
	}

	// Turnier Status in die Datenbank speichern
	async function saveToCloud() {
		if (!state.tournament || !window.dbFunctions) return;
		const { doc, setDoc } = window.dbFunctions;
		const winnerObj = {}; state.tournament.winnerBracket.forEach((r, i) => winnerObj[`round_${i}`] = r);
		const loserObj = {}; state.tournament.loserBracket.forEach((r, i) => loserObj[`round_${i}`] = r);
		await setDoc(doc(window.db, CONFIG.DB_COL, CONFIG.DB_DOC), {
			name: state.tournament.name, players: state.tournament.players,
			stepladder: state.tournament.stepladder, winnerBracket: winnerObj,
			loserBracket: loserObj, tournamentOver: state.tournament.tournamentOver,
			news: state.tournament.news || [],
			hasGroups: state.tournament.hasGroups === true,
			groups: state.tournament.groups || [],
			wbToLbMap: state.tournament.wbToLbMap || {},
			matchIdCounter: state.tournament.matchIdCounter || 0
		});
	}

	// Speichert die globalen Assets (Regeln, Dartautomat)
	async function saveAssetsToCloud() {
		if (!window.dbFunctions) return;
		if (!requireAdmin()) return;
		const { doc, setDoc } = window.dbFunctions;
		await setDoc(doc(window.db, CONFIG.DB_COL, CONFIG.ASSETS_DOC), state.globalAssets || {});
	}

	/**
	 * ============================================================
	 * 10. TOURNAMENT ARCHIVE SYSTEM
	 * ============================================================
	 */

	// Archiviert das aktuelle Turnier
	async function archiveTournament() {
		if (!state.tournament || !window.dbFunctions) return;
		if (!requireAdmin()) return;

		const { doc, setDoc } = window.dbFunctions;
		const archiveId = `tournament_${Date.now()}`;

		// Konvertiere Brackets für Speicherung
		const winnerObj = {};
		state.tournament.winnerBracket.forEach((r, i) => winnerObj[`round_${i}`] = r);
		const loserObj = {};
		state.tournament.loserBracket.forEach((r, i) => loserObj[`round_${i}`] = r);

		const archiveData = {
			id: archiveId,
			name: state.tournament.name,
			players: state.tournament.players,
			stepladder: state.tournament.stepladder,
			winnerBracket: winnerObj,
			loserBracket: loserObj,
			tournamentOver: state.tournament.tournamentOver,
			news: state.tournament.news || [],
			hasGroups: state.tournament.hasGroups === true,
			groups: state.tournament.groups || [],
			wbToLbMap: state.tournament.wbToLbMap || {},
			matchIdCounter: state.tournament.matchIdCounter || 0,
			archivedAt: Date.now()
		};

		await setDoc(doc(window.db, CONFIG.ARCHIVES_COL, archiveId), archiveData);
		showToast("Turnier archiviert!", "success");
	}

	// Löscht ein archiviertes Turnier
	async function deleteArchivedTournament(archiveId) {
		if (!requireAdmin()) return;
		showCustomDialog({
			title: "Turnier-Archiv löschen?",
			message: "Möchtest du dieses archivierte Turnier wirklich unwiderruflich löschen?",
			confirmText: "Endgültig Löschen",
			onConfirm: async () => {
				try {
					const { doc, deleteDoc } = window.dbFunctions;
					await deleteDoc(doc(window.db, CONFIG.ARCHIVES_COL, archiveId));
					showToast("Archiv gelöscht.", "success");
					loadTournamentArchives();
				} catch (e) {
					console.error(e);
					showToast("Fehler beim Löschen.", "danger");
				}
			}
		});
	}

	// Lädt alle archivierten Turniere
	async function loadTournamentArchives() {
		const list = document.getElementById('archiveList');
		list.innerHTML = '<p style="text-align:center; padding:20px;">Lade Archive...</p>';

		try {
			const { collection, getDocs } = window.dbFunctions;
			const snap = await getDocs(collection(window.db, CONFIG.ARCHIVES_COL));

			if (snap.empty) {
				list.innerHTML = '<p style="text-align:center; padding:20px; color:var(--text-dim);">Keine archivierten Turniere gefunden.</p>';
				return;
			}

			// Sortiere nach Datum (neueste zuerst)
			const archives = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }))
				.sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));

			state.archivedTournaments = archives;
			list.innerHTML = '';

			archives.forEach(archive => {
				const date = new Date(archive.archivedAt).toLocaleString('de-DE', {
					day: '2-digit',
					month: '2-digit',
					year: 'numeric',
					hour: '2-digit',
					minute: '2-digit'
				});

				// Berechne Top 3
				const podium = calculatePodium(archive);

				const div = document.createElement('div');
				div.className = 'participant-item';
				div.style.cursor = 'pointer';

				// Layouting
				const infoDiv = document.createElement('div');
				infoDiv.innerHTML = `
				<b style="font-size: 1rem;">${archive.name}</b><br>
				<small style="color:var(--text-dim)">📅 ${date}</small><br>
				<small style="color:var(--primary)">🥇 ${podium[0] || '-'} | 🥈 ${podium[1] || '-'} | 🥉 ${podium[2] || '-'}</small>
			`;

				const controlsDiv = document.createElement('div');
				controlsDiv.style.display = 'flex';
				controlsDiv.style.alignItems = 'center';
				controlsDiv.style.gap = '10px';

				// Admin Delete Button
				if (state.isAdmin) {
					const delBtn = document.createElement('button');
					delBtn.className = 'btn btn-danger small';
					delBtn.innerHTML = '🗑️';
					delBtn.title = 'Löschen';
					delBtn.onclick = (e) => {
						e.stopPropagation();
						deleteArchivedTournament(archive.id);
					};
					controlsDiv.appendChild(delBtn);
				}

				// View Icon
				const viewIcon = document.createElement('span');
				viewIcon.style.fontSize = '1.5rem';
				viewIcon.innerText = '👁️';
				controlsDiv.appendChild(viewIcon);

				div.appendChild(infoDiv);
				div.appendChild(controlsDiv);

				div.onclick = () => viewArchivedTournament(archive);
				list.appendChild(div);
			});
		} catch (e) {
			list.innerHTML = '<p style="color:var(--danger); text-align:center;">Fehler beim Laden.</p>';
			console.error(e);
		}
	}

	// Zeigt ein archiviertes Turnier an (Read-Only)
	function viewArchivedTournament(archiveData) {
		state.viewingArchive = true;
		const tournament = TournamentManager.fromJSON(archiveData);

		document.getElementById('archiveModal').classList.remove('active');
		document.getElementById('archivedTournamentModal').classList.add('active');
		document.getElementById('archivedTournamentTitle').textContent = `${archiveData.name} (Archiv)`;

		const content = document.getElementById('archivedTournamentContent');
		content.innerHTML = '';

		// Podium anzeigen
		if (tournament.tournamentOver) {
			const pod = calculatePodium(tournament);
			const podiumDiv = document.createElement('div');
			podiumDiv.className = 'card glass ranking-card';
			podiumDiv.style.marginBottom = '20px';
			podiumDiv.innerHTML = `
			<h3 style="text-align: center; margin-bottom: 20px;">🏆 Endstand 🏆</h3>
			<div class="podium">
				<div class="podium-item second">
					<div class="rank">2</div>
					<div class="player-name">${pod[1] || '-'}</div>
				</div>
				<div class="podium-item first">
					<div class="rank">1</div>
					<div class="player-name">${pod[0] || '-'}</div>
				</div>
				<div class="podium-item third">
					<div class="rank">3</div>
					<div class="player-name">${pod[2] || '-'}</div>
				</div>
			</div>
		`;
			content.appendChild(podiumDiv);
		}

		// Tab Navigation
		const tabNav = document.createElement('nav');
		tabNav.className = 'tab-nav';
		tabNav.innerHTML = `
		<button class="tab-btn active" data-tab="archive-news">News</button>
		${tournament.hasGroups ? '<button class="tab-btn" data-tab="archive-groups">👥 Gruppen</button>' : ''}
		<button class="tab-btn" data-tab="archive-winner">Winner Bracket</button>
		<button class="tab-btn" data-tab="archive-loser">Loser Bracket</button>
		${!tournament.hasGroups ? '<button class="tab-btn" data-tab="archive-stepladder">🏆 Stepladder Finale</button>' : ''}
	`;
		content.appendChild(tabNav);

		// Tab Inhalte
		const newsTab = document.createElement('div');
		newsTab.id = 'archive-news';
		newsTab.className = 'tab-content active';
		newsTab.style.marginTop = '20px';
		renderArchivedNews(newsTab, tournament.news || []);
		content.appendChild(newsTab);

		const groupsTab = document.createElement('div');
		groupsTab.id = 'archive-groups';
		groupsTab.className = 'tab-content';
		groupsTab.style.marginTop = '20px';
		groupsTab.innerHTML = '<div class="groups-grid"></div>';
		content.appendChild(groupsTab);

		const winnerTab = document.createElement('div');
		winnerTab.id = 'archive-winner';
		winnerTab.className = 'tab-content';
		winnerTab.style.marginTop = '20px';
		winnerTab.innerHTML = '<div class="bracket-scroll" style="position: relative;"></div>';
		content.appendChild(winnerTab);

		const loserTab = document.createElement('div');
		loserTab.id = 'archive-loser';
		loserTab.className = 'tab-content';
		loserTab.style.marginTop = '20px';
		loserTab.innerHTML = '<div class="bracket-scroll" style="position: relative;"></div>';
		content.appendChild(loserTab);

		const stepladderTab = document.createElement('div');
		stepladderTab.id = 'archive-stepladder';
		stepladderTab.className = 'tab-content';
		stepladderTab.style.marginTop = '20px';
		stepladderTab.innerHTML = '<div class="bracket-scroll" style="position: relative;"></div>';
		content.appendChild(stepladderTab);

		// Tab wechseln
		tabNav.querySelectorAll('.tab-btn').forEach(btn => {
			btn.onclick = () => {
				tabNav.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
				content.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
				btn.classList.add('active');
				content.querySelector(`#${btn.dataset.tab}`).classList.add('active');

				// Rendert brackets wenn Tab aktiv 
				if (btn.dataset.tab === 'archive-groups') {
					renderArchivedGroups(tournament, groupsTab.querySelector('.groups-grid'));
				} else if (btn.dataset.tab === 'archive-winner') {
					renderArchivedBracket(tournament, 'winnerBracket', winnerTab.querySelector('.bracket-scroll'));
				} else if (btn.dataset.tab === 'archive-loser') {
					renderArchivedBracket(tournament, 'loserBracket', loserTab.querySelector('.bracket-scroll'));
				} else if (btn.dataset.tab === 'archive-stepladder') {
					renderArchivedStepladder(tournament, stepladderTab.querySelector('.bracket-scroll'));
				}
			};
		});
	}

	// Rendert News für archivierte Turniere
	function renderArchivedNews(container, news) {
		const sortedNews = [...news].sort((a, b) => {
			if (a.pinned && !b.pinned) return -1;
			if (!a.pinned && b.pinned) return 1;
			return b.timestamp - a.timestamp;
		});

		if (sortedNews.length === 0) {
			container.innerHTML = '<p style="color: var(--text-dim); text-align: center; padding: 20px;">Keine Nachrichten vorhanden.</p>';
			return;
		}

		container.innerHTML = '';
		sortedNews.forEach(post => {
			const div = document.createElement('div');
			div.className = `news-item ${post.pinned ? 'pinned' : ''} ${post.system ? 'system' : ''}`;
			const date = new Date(post.timestamp).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

			div.innerHTML = `
			<div class="news-header">
				<div class="news-title-group">
					<h4 class="news-title">${post.title || 'Nachricht'}</h4>
					<span class="news-date">${post.pinned ? '📌 Gepinnt • ' : ''}${date}</span>
				</div>
			</div>
			<div class="news-content">${post.content.replace(/\n/g, '<br>')}</div>
		`;
			container.appendChild(div);
		});
	}

	// Rendert Bracket für archiviertes Turnier (Read-Only)
	function renderArchivedBracket(tournament, type, container) {
		container.innerHTML = '';
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('class', 'bracket-connector');
		Object.assign(svg.style, { position: 'absolute', top: '0', left: '0', width: '100%', height: '100%' });

		const gradientId = 'bracketGradient_archived_' + type;
		if (document.body.classList.contains('bracket-modern')) {
			const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
			defs.innerHTML = `
				<linearGradient id="${gradientId}" x1="0%" y1="0%" x2="100%" y2="0%">
					<stop offset="0%"   stop-color="var(--primary)" stop-opacity="0.8"/>
					<stop offset="100%" stop-color="rgba(139,92,246,0.5)"/>
				</linearGradient>`;
			svg.appendChild(defs);
		}

		container.appendChild(svg);

		const rounds = [];
		tournament[type].forEach((round, rI) => {
			const isFinalRound = rI === tournament[type].length - 1;
			const col = document.createElement('div');
			col.className = 'bracket-round';
			col.innerHTML = `<div class="badge" style="margin-bottom:15px; text-align:center">${isFinalRound ? (type === 'winnerBracket' ? "Finale & Platz 3" : "LB Finale") : `Runde ${rI + 1}`}</div>`;

			const matchesContainer = document.createElement('div');
			matchesContainer.className = 'bracket-matches-container';
			const matchElements = [];

			round.forEach((m) => {
				const groupDiv = document.createElement('div');
				groupDiv.className = 'match-group';
				let titleHtml = '';
				if (type === 'winnerBracket') {
					if (m.type === 'winner_3rd') titleHtml = `<div class="match-title bronze">🥉 Spiel um Platz 3 im WB</div>`;
					else if (isFinalRound && m.type === 'winner') titleHtml = `<div class="match-title">🏆 Spiel um Platz 1 im WB</div>`;
				}

				const div = document.createElement('div');
				const isP1B = TournamentManager.isBye(m.player1);
				const isP2B = TournamentManager.isBye(m.player2);
				const isPureBye = isP1B && isP2B;
				div.className = `match ${m.completed ? 'completed' : ''} ${isPureBye ? 'match-pure-bye' : ''}`;
				div.style.opacity = '0.8'; // Read-only indicator
				div.innerHTML = `${titleHtml}
				<div class="match-player ${m.winner === m.player1 && m.completed ? 'winner' : (m.loser === m.player1 && m.completed ? 'loser' : '')}"><span>${m.player1 || 'TBD'}</span><span class="match-score">${m.score1 === 0 && m.score2 === 0 && m.completed && isP1B ? '' : m.score1}</span></div>
				<div class="match-vs">vs</div>
				<div class="match-player ${m.winner === m.player2 && m.completed ? 'winner' : (m.loser === m.player2 && m.completed ? 'loser' : '')}"><span>${m.player2 || 'TBD'}</span><span class="match-score">${m.score1 === 0 && m.score2 === 0 && m.completed && isP2B ? '' : m.score2}</span></div>`;

				groupDiv.appendChild(div);
				matchesContainer.appendChild(groupDiv);
				matchElements.push(div);
			});

			col.appendChild(matchesContainer);
			container.appendChild(col);
			rounds.push({ col, matches: matchElements });
		});

		setTimeout(() => drawConnectors(svg, rounds, gradientId), 100);
	}

	// Rendert Stepladder für archiviertes Turnier (Read-Only)
	function renderArchivedStepladder(tournament, container) {
		container.innerHTML = '';
		tournament.stepladder.forEach(m => {
			const div = document.createElement('div');
			div.className = `match ${m.completed ? 'completed' : ''}`;
			div.style.minWidth = "320px";
			div.style.opacity = '0.8'; // Read-only indicator
			div.innerHTML = `<div style="font-size:0.7rem; color:var(--primary); margin-bottom:5px; font-weight:bold;">${m.title}</div>
			<div class="match-player ${m.winner === m.player1 && m.completed ? 'winner' : (m.loser === m.player1 && m.completed ? 'loser' : '')}"><span>${m.player1 || 'TBD'}</span><span class="match-score">${m.score1}</span></div>
			<div class="match-vs">vs</div>
			<div class="match-player ${m.winner === m.player2 && m.completed ? 'winner' : (m.loser === m.player2 && m.completed ? 'loser' : '')}"><span>${m.player2 || 'TBD'}</span><span class="match-score">${m.score2}</span></div>`;
			container.appendChild(div);
		});
	}

	/**
	 * ============================================================
	 * 11. EVENT-LISTENER (WENN DIE SEITE LÄDT)
	 * ============================================================
	 */

	document.addEventListener('DOMContentLoaded', () => {
		// Settings beim Laden anwenden
		loadSettings();

		// Settings-Button
		document.getElementById('settingsBtn').onclick = openSettingsModal;
		document.getElementById('closeSettingsModal').onclick = () => document.getElementById('settingsModal').classList.remove('active');
		document.getElementById('applySettingsBtn').onclick = applyAndSaveSettings;
		document.getElementById('resetSettingsBtn').onclick = resetSettings;

		// Settings Sidebar Navigation (Apple-Stil)
		document.querySelectorAll('.settings-nav-item').forEach(btn => {
			btn.onclick = () => {
				// Nav-Items: active setzen
				document.querySelectorAll('.settings-nav-item').forEach(b => b.classList.remove('active'));
				btn.classList.add('active');
				// Tab-Panes: aktiven wechseln
				const tab = btn.dataset.tab;
				document.querySelectorAll('.settings-tab-pane').forEach(p => p.classList.remove('active'));
				const pane = document.getElementById('settingsTab-' + tab);
				if (pane) pane.classList.add('active');
			};
		});

		// Farbpalette
		document.querySelectorAll('.color-swatch').forEach(btn => {
			btn.onclick = () => {
				document.querySelectorAll('.color-swatch').forEach(b => b.classList.remove('active'));
				btn.classList.add('active');
			};
		});

		// Settings-Modal schließen -> bei Klick auf Hintergrund
		document.getElementById('settingsModal').addEventListener('click', e => {
			if (e.target === document.getElementById('settingsModal')) {
				document.getElementById('settingsModal').classList.remove('active');
			}
		});

		// Login Fenster -> sobald die Seite angezeigt wird
		document.getElementById('mainLoginForm').onsubmit = async e => {
			e.preventDefault();
			const success = await authenticate(document.getElementById('authUsername').value, document.getElementById('authPassword').value);
			if (success) {
				updateUI();
				showToast("Erfolgreich eingeloggt", "success");
			} else {
				showToast("Login fehlgeschlagen", "danger");
			}
		};

		// Live Syncronisation mit der Datenbank
		const startSync = () => {
			if (window.dbFunctions) {
				// Turnier Sync
				window.dbFunctions.onSnapshot(window.dbFunctions.doc(window.db, CONFIG.DB_COL, CONFIG.DB_DOC), s => {
					state.tournament = s.exists() ? TournamentManager.fromJSON(s.data()) : null; updateUI();
				});
				// Assets Sync
				window.dbFunctions.onSnapshot(window.dbFunctions.doc(window.db, CONFIG.DB_COL, CONFIG.ASSETS_DOC), s => {
					state.globalAssets = s.exists() ? s.data() : {}; updateUI();
				});
			} else setTimeout(startSync, 100);
		};
		startSync();

		// Tap Umschaltung (Winner bracket /Loser bracket)
		document.querySelectorAll('.tab-btn').forEach(btn => {
			btn.onclick = () => {
				document.querySelectorAll('.tab-btn, .tab-content').forEach(el => el.classList.remove('active'));
				btn.classList.add('active');
				if (btn.dataset.tab && document.getElementById(btn.dataset.tab)) {
					document.getElementById(btn.dataset.tab).classList.add('active');
				}
				if (state.tournament && (btn.dataset.tab.includes('Bracket'))) {
					renderBracket('winnerBracket'); renderBracket('loserBracket');
				}
				if (state.tournament && btn.dataset.tab === 'groupsSection') {
					renderGroups();
				}
			};
		});

		// Event listener für Buttons
		document.getElementById('participantsBtn').onclick = () => { loadParticipants(); document.getElementById('participantsModal').classList.add('active'); };
		document.getElementById('userMgmtBtn').onclick = () => {
			if (!requireAdmin()) return;
			document.getElementById('userSearchBar').value = '';
			loadUsers();
			document.getElementById('userModal').classList.add('active');
		};

		// User Erstellung 
		document.getElementById('userSearchBar').oninput = e => loadUsers(e.target.value);
		document.getElementById('createUserBtn').onclick = async () => {
			if (!requireAdmin()) return;
			const u = document.getElementById('newUserName').value.trim();
			const p = document.getElementById('newUserPass').value.trim();
			const isAdminUser = document.getElementById('newUserIsAdmin').checked;
			if (!u || !p) { showToast("Name und Passwort nötig!", "danger"); return; }

			try {
				const hashedPassword = await hashPassword(p);
				await window.dbFunctions.setDoc(window.dbFunctions.doc(window.db, CONFIG.USERS_COL, u), { password: hashedPassword, isAdmin: isAdminUser });
				showToast(`Benutzer angelegt! ${isAdminUser ? '(Admin)' : '(Zuschauer)'}`, "success");
				document.getElementById('newUserName').value = '';
				document.getElementById('newUserPass').value = '';
				document.getElementById('newUserIsAdmin').checked = false;
				loadUsers();
			} catch (e) {
				showToast("Fehler beim Erstellen", "danger");
				console.error(e);
			}
		};

		// Fenster schließen Events
		document.getElementById('closeUserModal').onclick = () => document.getElementById('userModal').classList.remove('active');
		document.getElementById('closeParticipants').onclick = () => document.getElementById('participantsModal').classList.remove('active');
		document.getElementById('closeImageModal').onclick = () => document.getElementById('imageModal').classList.remove('active');
		document.getElementById('closeGroupDetailsModal').onclick = () => {
			state.currentGroupIndex = null;
			document.getElementById('groupDetailsModal').classList.remove('active');
		};
		document.getElementById('saveMatchBtn').onclick = handleResult;
		document.getElementById('closeModal').onclick = () => document.getElementById('matchModal').classList.remove('active');

		// Logout Logik
		document.getElementById('adminLogoutBtn').onclick = () => {
			showCustomDialog({
				title: "Abmelden",
				message: `Möchtest du dich wirklich als "${state.currentUser?.username}" abmelden?`,
				confirmText: "Abmelden",
				onConfirm: () => {
					state.currentUser = null;
					state.isAdmin = false;
					updateUI();
				}
			});
		};

		// Turnier löschen
		document.getElementById('deleteTournamentBtn').onclick = async () => {
			verifyAdminAction(() => {
				showCustomDialog({
					title: "Turnier löschen?",
					message: "Diese Aktion kann nicht rückgängig gemacht werden!",
					confirmText: "Endgültig Löschen",
					onConfirm: async () => {
						await window.dbFunctions.setDoc(window.dbFunctions.doc(window.db, CONFIG.DB_COL, CONFIG.DB_DOC), {});
						state.tournament = null;
						updateUI();
						showToast("Turnier gelöscht", "danger");
					}
				});
			});
		};

		// Spieler Eingabefelder 
		const addP = () => {
			const container = document.getElementById('playerInputs');
			const count = container.children.length;

			const div = document.createElement('div');
			div.className = 'player-input-row';
			div.style.display = 'flex';
			div.style.alignItems = 'center';
			div.style.gap = '10px';

			const playerNum = document.createElement('div');
			playerNum.style.fontSize = '0.7rem';
			playerNum.style.fontWeight = '800';
			playerNum.style.minWidth = '30px';
			playerNum.style.opacity = '0.6';
			playerNum.textContent = `${count + 1}.`;
			// Eingabe Feld für Name
			const inp = document.createElement('input');
			inp.className = 'form-input player-in';
			inp.placeholder = 'Name';
			inp.style.flex = '1';
			inp.style.margin = '0';
			// Delete Button
			const delBtn = document.createElement('button');
			delBtn.type = 'button';
			delBtn.className = 'btn btn-danger';
			delBtn.style.padding = '5px 12px';
			delBtn.textContent = '🗑️';
			delBtn.onclick = () => {
				div.remove();
				Array.from(container.children).forEach((row, idx) => {
					const label = row.querySelector('div');
					if (label) label.textContent = `${idx + 1}.`;
				});
			};

			div.appendChild(playerNum);
			div.appendChild(inp);
			div.appendChild(delBtn);
			container.appendChild(div);
		};
		// Neues Turnier erstellen
		document.getElementById('newTournamentBtn').onclick = () => {
			verifyAdminAction(() => {
				document.getElementById('setupSection').classList.add('active');
				document.getElementById('playerInputs').innerHTML = '';
				for (let i = 0; i < 4; i++) addP();
			});
		};
		// Easter Egg: 3 Klicks auf den Pokal generiert 32 Spieler
		let trophyClicks = 0;
		let trophyTimer = null;
		const setupTrophy = document.getElementById('setupTrophy');
		if (setupTrophy) {
			setupTrophy.onclick = () => {
				trophyClicks++;
				if (trophyTimer) clearTimeout(trophyTimer);
				trophyTimer = setTimeout(() => { trophyClicks = 0; }, 2000);

				if (trophyClicks >= 3) {
					trophyClicks = 0;
					const container = document.getElementById('playerInputs');
					container.innerHTML = '';
					for (let i = 1; i <= 32; i++) {
						addP();
						const inputs = container.querySelectorAll('.player-in');
						const lastInp = inputs[inputs.length - 1];
						if (lastInp) lastInp.value = `Spieler ${i}`;
					}
					showToast("Developer Test Modus aktiviert", "success");
				}
			};
		}

		document.getElementById('addPlayerBtn').onclick = addP;
		document.getElementById('setupForm').onsubmit = async e => {
			e.preventDefault();
			if (!requireAdmin()) return;

			let p = Array.from(document.querySelectorAll('.player-in')).map(i => i.value.trim() || 'FREILOS');
			const hasGroups = document.getElementById('hasGroupsToggle')?.checked || false;

			state.tournament = new TournamentManager(
				document.getElementById('tournamentName').value,
				p,
				document.getElementById('shuffleToggle').checked,
				hasGroups
			);
			await saveToCloud();
			document.getElementById('setupSection').classList.remove('active');
		};

		// Archive Button Event Listener
		document.getElementById('archiveBtn').onclick = () => {
			loadTournamentArchives();
			document.getElementById('archiveModal').classList.add('active');
		};
		document.getElementById('closeArchiveModal').onclick = () => {
			document.getElementById('archiveModal').classList.remove('active');
		};
		document.getElementById('closeArchivedTournamentModal').onclick = () => {
			state.viewingArchive = false;
			document.getElementById('archivedTournamentModal').classList.remove('active');
			document.getElementById('archiveModal').classList.add('active');
		};

		// Changelog Modal Event Listener
		document.getElementById('versionTag').onclick = () => {
			document.getElementById('changelogModal').classList.add('active');
		};
		document.getElementById('closeChangelogModal').onclick = () => {
			document.getElementById('changelogModal').classList.remove('active');
		};

		// Feedback System initialisieren
		initFeedbackSystem();

		// Registration System initialisieren
		initRegistrationSystem();

		// Spielplanung initialisieren
		initGamePlanning();
	});

	/**
	 * ============================================================
	 * 11. FEEDBACK & UMFRAGEN SYSTEM
	 * ============================================================
	 */

	function initFeedbackSystem() {
		// Button im Home-Menü
		const fbBtn = document.getElementById('feedbackBtn');
		if (fbBtn) {
			fbBtn.onclick = () => {
				loadForms();
				document.getElementById('feedbackListModal').classList.add('active');
			};
		}

		// Modal Schließen Buttons
		document.getElementById('closeFeedbackListModal').onclick = () => {
			document.getElementById('feedbackListModal').classList.remove('active');
		};
		document.getElementById('closeUserFormBtn').onclick = () => {
			document.getElementById('feedbackFormModal').classList.remove('active');
		};
		document.getElementById('cancelBuilderBtn').onclick = () => {
			showCustomDialog({
				title: "Änderungen verwerfen?",
				message: "Möchtest du wirklich abbrechen? Alle nicht gespeicherten Änderungen gehen verloren.",
				confirmText: "Verwerfen",
				onConfirm: () => {
					document.getElementById('formBuilderModal').classList.remove('active');
					state.editingFormId = null; // Reset editing state
				}
			});
		};
		document.getElementById('closeResponseViewerBtn').onclick = () => {
			document.getElementById('responseViewerModal').classList.remove('active');
		};

		// Admin Controls
		document.getElementById('createNewFormBtn').onclick = openFormBuilder;
		document.getElementById('saveFormBtn').onclick = saveNewForm;
		document.getElementById('submitFeedbackBtn').onclick = submitFeedback;

		window.addQuestionToBuilder = addQuestionToBuilder;
	}

	// Lädt alle aktiven Umfragen aus der DB
	async function loadForms() {
		const list = document.getElementById('feedbackFormsList');
		const adminControls = document.getElementById('adminFeedbackControls');

		// Admin Controls anzeigen
		if (state.isAdmin) adminControls.classList.remove('hidden');
		else adminControls.classList.add('hidden');

		list.innerHTML = '<p style="text-align: center; color: var(--text-dim); padding: 20px;">Lade Formulare...</p>';

		try {
			const { collection, getDocs } = window.dbFunctions;
			const snap = await getDocs(collection(window.db, CONFIG.FORMS_COL));

			state.activeForms = [];
			snap.forEach(doc => {
				const data = doc.data();
				if (data.active !== false || state.isAdmin) { // Auch inaktive Umfragen anzeigen -> für Admins
					state.activeForms.push({ id: doc.id, ...data });
				}
			});

			// Sortieren nach Erstellung (neueste zuerst)
			state.activeForms.sort((a, b) => b.createdAt - a.createdAt);

			renderFormList();
		} catch (e) {
			console.error(e);
			list.innerHTML = '<p style="color: var(--danger); text-align: center;">Fehler beim Laden.</p>';
			showToast("Fehler beim Laden der Formulare", "danger");
		}
	}

	function renderFormList() {
		const list = document.getElementById('feedbackFormsList');
		list.innerHTML = '';

		if (state.activeForms.length === 0) {
			list.innerHTML = '<p style="text-align: center; color: var(--text-dim); padding: 20px;">Keine Umfragen verfügbar.</p>';
			return;
		}

		state.activeForms.forEach(form => {
			const div = document.createElement('div');
			div.className = 'participant-item';
			// Nutzer sehen die Umfrage nur, wenn sie aktiv ist.
			if (!state.isAdmin && form.active === false) return;

			div.innerHTML = `
            <div style="flex:1; cursor:pointer;" onclick="openFeedbackForm('${form.id}')">
                <div style="font-weight:bold; color: var(--text-main);">${form.title} ${form.active === false ? '<span style="color:var(--danger); font-size:0.8em;">(Inaktiv)</span>' : ''}</div>
                <div style="font-size:0.8rem; color: var(--text-dim);">${form.description || ''}</div>
            </div>
        `;
			// Admin prüfung
			if (state.isAdmin) {
				const controls = document.createElement('div');
				controls.style.display = 'flex';
				controls.style.gap = '5px';

				// Ergebnisse anzeigen
				const btnResults = document.createElement('button');
				btnResults.className = 'btn btn-outline small';
				btnResults.innerHTML = '📊';
				btnResults.title = 'Ergebnisse';
				btnResults.onclick = (e) => { e.stopPropagation(); viewResults(form.id); };

				// Bearbeiten
				const btnEdit = document.createElement('button');
				btnEdit.className = 'btn btn-outline small';
				btnEdit.innerHTML = '✏️';
				btnEdit.title = 'Bearbeiten';
				btnEdit.onclick = (e) => { e.stopPropagation(); editForm(form.id); };

				// Deaktivieren / Aktivieren
				const btnToggle = document.createElement('button');
				btnToggle.className = 'btn btn-outline small';
				btnToggle.innerHTML = form.active !== false ? '✅' : '🚫';
				btnToggle.title = form.active !== false ? 'Deaktivieren' : 'Aktivieren';
				btnToggle.onclick = (e) => { e.stopPropagation(); toggleFormStatus(form.id, form.active !== false); };

				// Löschen
				const btnDelete = document.createElement('button');
				btnDelete.className = 'btn btn-danger small';
				btnDelete.innerHTML = '🗑️';
				btnDelete.title = 'Löschen';
				btnDelete.onclick = (e) => { e.stopPropagation(); deleteForm(form.id); };

				controls.append(btnResults, btnEdit, btnToggle, btnDelete);
				div.appendChild(controls);
			} else {
				const arrow = document.createElement('div');
				arrow.style.fontSize = '1.2rem';
				arrow.style.cursor = 'pointer';
				arrow.innerText = '👉';
				arrow.onclick = () => openFeedbackForm(form.id);
				div.appendChild(arrow);
			}

			list.appendChild(div);
		});
	}

	// Öffnet die View Ansicht für die Nutzer
	function openFeedbackForm(formId) {
		const form = state.activeForms.find(f => f.id === formId);
		if (!form) return;

		state.currentForm = form;
		const container = document.getElementById('userFormContainer');
		container.innerHTML = '';

		// Überschrift
		const title = document.createElement('h2');
		title.style.textAlign = 'center';
		title.style.marginBottom = '10px';
		title.textContent = form.title;
		container.appendChild(title);

		if (form.description) {
			const desc = document.createElement('p');
			desc.style.textAlign = 'center';
			desc.style.color = 'var(--text-dim)';
			desc.style.marginBottom = '25px';
			desc.textContent = form.description;
			container.appendChild(desc);
		}

		const formEl = document.createElement('form');
		formEl.id = 'activeFeedbackForm';

		// Fragen rendern
		form.questions.forEach(q => {
			const wrapper = document.createElement('div');
			wrapper.className = 'form-group glass';
			wrapper.style.padding = '15px';
			wrapper.style.marginBottom = '15px';
			wrapper.style.borderRadius = '8px';

			const label = document.createElement('label');
			label.className = 'form-label';
			label.innerHTML = `${q.label} ${q.required ? '<span style="color:var(--danger)">*</span>' : ''}`;
			wrapper.appendChild(label);

			if (q.type === 'text') {
				const input = document.createElement('input');
				input.type = 'text';
				input.className = 'form-input';
				input.name = q.id;
				if (q.required) input.required = true;
				wrapper.appendChild(input);
			} else if (q.type === 'textarea') {
				const input = document.createElement('textarea');
				input.className = 'form-input';
				input.rows = 3;
				input.name = q.id;
				if (q.required) input.required = true;
				wrapper.appendChild(input);
			} else if (q.type === 'rating') {
				const ratingContainer = document.createElement('div');
				ratingContainer.style.display = 'flex';
				ratingContainer.style.gap = '10px';
				ratingContainer.style.fontSize = '1.5rem';
				ratingContainer.style.cursor = 'pointer';

				// Hidden Input für den Wert 
				const input = document.createElement('input');
				input.type = 'hidden';
				input.name = q.id;
				if (q.required) input.required = true;
				wrapper.appendChild(input);

				// 5 Sterne Fragen Type
				for (let i = 1; i <= 5; i++) {
					const star = document.createElement('span');
					star.textContent = '☆';
					star.dataset.value = i;
					star.onclick = () => {
						input.value = i;
						// Visuelles Update der Sterne 
						Array.from(ratingContainer.children).forEach(s => {
							if (s.tagName === 'SPAN') s.textContent = s.dataset.value <= i ? '⭐' : '☆';
						});
					};
					ratingContainer.appendChild(star);
				}
				wrapper.appendChild(ratingContainer);
			} else if (q.type === 'radio') {
				if (q.options && q.options.length > 0) {
					q.options.forEach(opt => {
						const optWrapper = document.createElement('div');
						optWrapper.style.display = 'flex';
						optWrapper.style.alignItems = 'center';
						optWrapper.style.gap = '8px';
						optWrapper.style.marginBottom = '5px';

						const radio = document.createElement('input');
						radio.type = 'radio';
						radio.name = q.id;
						radio.value = opt;
						if (q.required) radio.required = true;

						const optLabel = document.createElement('label');
						optLabel.textContent = opt;
						// Klick auf Label wählt Radio (Radio button = Der Nutzer kann eine Option aus einer Liste auswählen)
						optLabel.onclick = () => radio.click();

						optWrapper.appendChild(radio);
						optWrapper.appendChild(optLabel);
						wrapper.appendChild(optWrapper);
					});
				}
			} else if (q.type === 'checkbox') {
				if (q.options && q.options.length > 0) {
					q.options.forEach(opt => {
						const optWrapper = document.createElement('div');
						optWrapper.style.display = 'flex';
						optWrapper.style.alignItems = 'center';
						optWrapper.style.gap = '8px';
						optWrapper.style.marginBottom = '5px';

						const chk = document.createElement('input');
						chk.type = 'checkbox';
						chk.name = q.id;
						chk.value = opt;

						const optLabel = document.createElement('label');
						optLabel.textContent = opt;

						optWrapper.appendChild(chk);
						optWrapper.appendChild(optLabel);
						wrapper.appendChild(optWrapper);
					});
				}
			}

			formEl.appendChild(wrapper);
		});

		container.appendChild(formEl);
		document.getElementById('feedbackFormModal').classList.add('active');
	}

	// Antworten absenden
	async function submitFeedback() {
		const formEl = document.getElementById('activeFeedbackForm');
		if (!formEl) return;

		//  Validierung
		if (!formEl.checkValidity()) {
			formEl.reportValidity();
			return;
		}

		const formData = new FormData(formEl);
		const answers = {};

		state.currentForm.questions.forEach(q => {
			if (q.type === 'checkbox') {
				const checked = formEl.querySelectorAll(`input[name="${q.id}"]:checked`);
				if (checked.length > 0) {
					answers[q.id] = Array.from(checked).map(c => c.value);
				}
			} else {
				const val = formData.get(q.id);
				if (val !== null && val !== "") answers[q.id] = val;
			}
		});

		// Validierung für Pflichtfelder
		let missingFields = [];
		state.currentForm.questions.forEach(q => {
			if (q.required) {
				const hasValue = (q.type === 'checkbox') ?
					(answers[q.id] && answers[q.id].length > 0) :
					(answers[q.id] !== undefined && answers[q.id] !== "");

				if (!hasValue) {
					missingFields.push(q.label);
				}
			}
		});

		if (missingFields.length > 0) {
			showToast(`Bitte folgende Pflichtfelder ausfüllen: ${missingFields[0]}`, "warning");
			return;
		}

		try {
			const { doc, setDoc } = window.dbFunctions;
			const responseId = 'resp_' + Date.now();
			const responseData = {
				formId: state.currentForm.id,
				formTitle: state.currentForm.title,
				userId: state.currentUser ? state.currentUser.username : 'Anonymous',
				answers: answers,
				submittedAt: Date.now()
			};

			await setDoc(doc(window.db, CONFIG.RESPONSES_COL, responseId), responseData);

			showToast("Vielen Dank für dein Feedback!", "success");
			document.getElementById('feedbackFormModal').classList.remove('active');
			document.getElementById('feedbackListModal').classList.remove('active'); // Close list too
		} catch (e) {
			console.error(e);
			showToast("Fehler beim Senden.", "danger");
		}
	}

	// --- BUILDER LOGIK (ADMIN) ---

	let builderQuestionCounter = 0;

	function openFormBuilder() {
		if (!requireAdmin()) return;
		document.getElementById('builderFormTitle').value = '';
		document.getElementById('builderFormDesc').value = '';
		document.getElementById('builderQuestionsContainer').innerHTML = '';
		builderQuestionCounter = 0;

		document.getElementById('feedbackListModal').classList.remove('active');
		document.getElementById('formBuilderModal').classList.add('active');

		state.editingFormId = null; // New state fürs bearbeiten
	}

	function addQuestionToBuilder(type) {
		const container = document.getElementById('builderQuestionsContainer');
		const id = `q_${builderQuestionCounter++}`;

		const div = document.createElement('div');
		div.className = 'glass';
		div.style.padding = '15px';
		div.style.borderRadius = '8px';
		div.style.position = 'relative';
		div.dataset.id = id;
		div.dataset.type = type;

		// Content Setup (Grundgerüst)
		let content = `<strong style="color:var(--primary); text-transform:uppercase; font-size:0.8rem;">${type}</strong>`;

		content += `
        <div style="margin-top:10px;">
            <label class="form-label">Frage / Titel</label>
            <input type="text" class="form-input q-label" placeholder="Was möchtest du fragen?" required>
        </div>
        <div style="margin-top:10px; display:flex; align-items:center; gap:10px;">
            <input type="checkbox" class="q-required" id="req_${id}">
            <label for="req_${id}">Pflichtfeld?</label>
        </div>
    `;

		if (type === 'radio' || type === 'checkbox') {
			content += `
            <div style="margin-top:10px;">
                <label class="form-label">Antwort-Optionen (mit Komma trennen)</label>
                <input type="text" class="form-input q-options" placeholder="Option A, Option B, Option C">
            </div>
        `;
		}

		div.innerHTML = content;

		// Delete Button hinzufügen
		const delBtn = document.createElement('button');
		delBtn.innerHTML = '🗑️';
		delBtn.className = 'btn btn-danger small';
		delBtn.type = 'button'; // Speicherung verhindern
		delBtn.style.position = 'absolute';
		delBtn.style.top = '10px';
		delBtn.style.right = '10px';
		delBtn.onclick = () => div.remove();
		div.appendChild(delBtn);

		container.appendChild(div);
		div.scrollIntoView({ behavior: 'smooth' });
	}

	async function saveNewForm() {
		if (!requireAdmin()) return;
		const title = document.getElementById('builderFormTitle').value.trim();
		const desc = document.getElementById('builderFormDesc').value.trim();

		if (!title) { showToast("Bitte einen Titel eingeben.", "danger"); return; }

		const questions = [];
		const qDivs = document.querySelectorAll('#builderQuestionsContainer > div');

		qDivs.forEach(div => {
			const type = div.dataset.type;
			const id = div.dataset.id;
			const label = div.querySelector('.q-label').value.trim();
			const required = div.querySelector('.q-required').checked;

			let options = [];
			if (type === 'radio' || type === 'checkbox') {
				const optsStr = div.querySelector('.q-options').value;
				if (optsStr) {
					options = optsStr.split(',').map(s => s.trim()).filter(s => s);
				}
			}

			if (label) {
				questions.push({ id, type, label, required, options });
			}
		});

		// Prüfung, ob das Formular mindestens 1 Frage hat
		if (questions.length === 0) {
			showToast("Das Formular braucht mindestens eine Frage.", "danger");
			return;
		}

		try {
			const { doc, setDoc } = window.dbFunctions;
			// Benutzt die bestehende ID zum bearbeiten
			const formId = state.editingFormId ? state.editingFormId : 'form_' + Date.now();
			const formData = {
				id: formId,
				title,
				description: desc,
				active: true, // Setzt nach jeder bearbeitung die Umfrage auf aktiv
				createdAt: state.editingFormId ? (state.activeForms.find(f => f.id === formId)?.createdAt || Date.now()) : Date.now(),
				createdBy: state.currentUser ? state.currentUser.username : 'Admin',
				questions
			};

			await setDoc(doc(window.db, CONFIG.FORMS_COL, formId), formData, { merge: true });

			showToast(state.editingFormId ? "Formular aktualisiert!" : "Formular erstellt!", "success"); // Bestätigungs Benachrichtigung
			document.getElementById('formBuilderModal').classList.remove('active');
			state.editingFormId = null;
			loadForms();
			document.getElementById('feedbackListModal').classList.add('active');
		} catch (e) {
			console.error(e);
			showToast("Fehler beim Speichern.", "danger"); // Fehlermeldung 
		}
	}

	// --- MANAGEMENT FUNKTIONEN ---

	async function deleteForm(formId) {
		if (!requireAdmin()) return;
		// Bestätigungs Dialog (Löschen)
		showCustomDialog({
			title: "Formular löschen?",
			message: "Möchtest du dieses Formular wirklich endgültig löschen? Alle Antworten gehen unwiderruflich verloren!",
			confirmText: "Löschen",
			onConfirm: async () => {
				try {
					const { doc, deleteDoc } = window.dbFunctions;
					await deleteDoc(doc(window.db, CONFIG.FORMS_COL, formId));
					showToast("Formular gelöscht.", "success"); // Bestätigungs Meldung
					loadForms();
				} catch (e) {
					console.error(e);
					showToast("Fehler beim Löschen.", "danger"); // Fehlermeldung
				}
			}
		});
	}

	// Status toggeln (Aktiv /Inaktiv)
	async function toggleFormStatus(formId, isActive) {
		if (!requireAdmin()) return;
		try {
			const { doc, updateDoc } = window.dbFunctions;
			await updateDoc(doc(window.db, CONFIG.FORMS_COL, formId), {
				active: !isActive
			});
			loadForms();
		} catch (e) {
			console.error(e);
			showToast("Fehler beim Aktualisieren.", "danger"); // Fehlermeldung
		}
	}

	// Umfragen bearbeiten
	function editForm(formId) {
		if (!requireAdmin()) return;
		const form = state.activeForms.find(f => f.id === formId);
		if (!form) return;

		state.editingFormId = formId;

		// Daten Laden
		document.getElementById('builderFormTitle').value = form.title;
		document.getElementById('builderFormDesc').value = form.description || '';
		document.getElementById('builderQuestionsContainer').innerHTML = '';
		builderQuestionCounter = 0;

		// Fragen rekonstruiren
		form.questions.forEach(q => {

			// Benutzerdefiniertes hinzufügen
			addQuestionToBuilder(q.type);
			const lastDiv = document.getElementById('builderQuestionsContainer').lastElementChild;

			// Label aktualisieren
			lastDiv.querySelector('.q-label').value = q.label;
			lastDiv.querySelector('.q-required').checked = q.required;

			// Optionen aktualisieren
			if (q.options && (q.type === 'radio' || q.type === 'checkbox')) {
				lastDiv.querySelector('.q-options').value = q.options.join(', ');
			}
		});

		document.getElementById('feedbackListModal').classList.remove('active');
		document.getElementById('formBuilderModal').classList.add('active');
		showToast("Achtung: Bearbeiten ändert IDs der Fragen möglicherweise!", "warning");
	}

	// --- ERGEBNISSE ANZEIGEN ---

	async function viewResults(formId) {
		if (!requireAdmin()) return;
		const form = state.activeForms.find(f => f.id === formId);
		if (!form) return;

		document.getElementById('feedbackListModal').classList.remove('active');
		document.getElementById('responseViewerTitle').textContent = `Ergebnisse: ${form.title}`;
		const container = document.getElementById('responseListContainer');
		container.innerHTML = '<p style="padding:20px; text-align:center;">Lade Antworten...</p>';
		document.getElementById('responseViewerModal').classList.add('active');

		try {
			const { collection, getDocs, query, where } = window.dbFunctions;
			const q = query(collection(window.db, CONFIG.RESPONSES_COL), where("formId", "==", formId));
			const snap = await getDocs(q);

			if (snap.empty) {
				container.innerHTML = '<p style="padding:20px; text-align:center; color:var(--text-dim);">Noch keine Antworten.</p>';
				return;
			}

			const responses = [];
			snap.forEach(d => responses.push(d.data()));
			// Sortiert nach dem Datum
			responses.sort((a, b) => b.submittedAt - a.submittedAt);

			renderResponseList(form, responses);

		} catch (e) {
			console.error(e);
			container.innerHTML = '<p style="padding:20px; text-align:center; color:var(--danger);">Fehler beim Laden.</p>';
		}
	}

	function renderResponseList(form, responses) {
		const container = document.getElementById('responseListContainer');
		container.innerHTML = '';

		// 1. DIAGRAMMABSCHNITT
		const chartQuestions = form.questions.filter(q => q.type === 'rating' || q.type === 'radio' || q.type === 'checkbox');

		if (chartQuestions.length > 0) {
			const chartGrid = document.createElement('div');
			chartGrid.className = 'chart-grid';

			chartQuestions.forEach(q => {
				const chartCard = document.createElement('div');
				chartCard.className = 'chart-card';

				const title = document.createElement('h4');
				title.style.marginBottom = '10px';
				title.style.textAlign = 'center';
				title.textContent = q.label;
				chartCard.appendChild(title);

				const canvasContainer = document.createElement('div');
				canvasContainer.className = 'chart-canvas-container';
				const canvas = document.createElement('canvas');
				canvasContainer.appendChild(canvas);
				chartCard.appendChild(canvasContainer);

				chartGrid.appendChild(chartCard);

				// Daten berechnen
				const counts = {};

				if (q.type === 'rating') {
					// Initialisieren für 1-5 Sterne
					for (let i = 1; i <= 5; i++) counts[i] = 0;
				} else if ((q.type === 'radio' || q.type === 'checkbox') && q.options) {
					q.options.forEach(o => counts[o] = 0);
				}

				responses.forEach(r => {
					const ans = r.answers[q.id];
					if (ans) {
						if (Array.isArray(ans)) { // Checkbox
							ans.forEach(val => { if (counts[val] !== undefined) counts[val]++; });
						} else { // Radio / Rating
							if (counts[ans] !== undefined) counts[ans]++;
						}
					}
				});

				// Diagrammkonfiguration vorbereiten
				let chartType = 'bar';
				let labels = Object.keys(counts);
				let dataValues = Object.values(counts);
				let bgColors = 'rgba(59, 130, 246, 0.5)';
				let borderColors = 'rgba(59, 130, 246, 1)';

				if (q.type === 'rating') {
					labels = ['1 ⭐', '2 ⭐', '3 ⭐', '4 ⭐', '5 ⭐'];
				} else {
					chartType = 'doughnut';
					bgColors = [
						'rgba(255, 99, 132, 0.5)',
						'rgba(54, 162, 235, 0.5)',
						'rgba(255, 206, 86, 0.5)',
						'rgba(75, 192, 192, 0.5)',
						'rgba(153, 102, 255, 0.5)',
						'rgba(255, 159, 64, 0.5)'
					];
					borderColors = bgColors.map(c => c.replace('0.5', '1'));
				}

				// Berechnen der Charts
				new Chart(canvas, {
					type: chartType,
					data: {
						labels: labels,
						datasets: [{
							label: '# Abstimmungen',
							data: dataValues,
							backgroundColor: bgColors,
							borderColor: borderColors,
							borderWidth: 1
						}]
					},
					options: {
						responsive: true,
						maintainAspectRatio: false,
						plugins: {
							legend: {
								display: chartType !== 'bar',
								labels: { color: '#94a3b8' }
							}
						},
						scales: chartType === 'bar' ? {
							y: {
								beginAtZero: true,
								ticks: { color: '#94a3b8', stepSize: 1 },
								grid: { color: 'rgba(255, 255, 255, 0.1)' }
							},
							x: {
								ticks: { color: '#94a3b8' },
								grid: { display: false }
							}
						} : {}
					}
				});
			});

			container.appendChild(chartGrid);

			const hr = document.createElement('hr');
			hr.style.borderColor = 'var(--border)';
			hr.style.margin = '20px 0';
			container.appendChild(hr);
		}


		// 2. TEXT EINGABEN
		responses.forEach(resp => {
			const card = document.createElement('div');
			card.className = 'glass';
			card.style.padding = '15px';
			card.style.marginBottom = '10px';
			card.style.borderRadius = '8px';

			const dateStr = new Date(resp.submittedAt).toLocaleString('de-DE');

			let html = `
            <div style="display:flex; justify-content:flex-end; margin-bottom:10px; border-bottom:1px solid var(--border); padding-bottom:5px;">
                <small>${dateStr}</small>
            </div>
            <div style="font-size:0.9rem;">
        `;

			form.questions.forEach(q => {
				const ans = resp.answers[q.id];
				let ansDisplay = '<span style="color:var(--text-dim);">-</span>';
				if (ans) {
					if (Array.isArray(ans)) ansDisplay = ans.join(', ');
					else if (q.type === 'rating') ansDisplay = ans + ' ⭐'; // Zeigt die Sterne im Text
					else ansDisplay = ans;
				}

				html += `
                <div style="margin-bottom:5px;">
                    <span style="color:var(--primary); font-weight:600;">${q.label}:</span> 
                    <span>${ansDisplay}</span>
                </div>
            `;
			});

			html += `</div>`;
			card.innerHTML = html;
			container.appendChild(card);
		});
	}

	/**
	 * ============================================================
	 * 12. TURNIERANMELDUNG SYSTEM
	 * ============================================================
	 */

	function initRegistrationSystem() {
		// Buttons
		const regBtn = document.getElementById('registrationBtn');
		if (regBtn) {
			regBtn.addEventListener('click', openRegistrationModal);
		}

		const regBtnLogin = document.getElementById('registrationBtnLogin');
		if (regBtnLogin) {
			regBtnLogin.addEventListener('click', openRegistrationModal);
		}

		document.getElementById('closeRegistrationModal').onclick = () => document.getElementById('registrationModal').classList.remove('active');
		document.getElementById('closeRegistrationModalAlt').onclick = () => document.getElementById('registrationModal').classList.remove('active');

		document.getElementById('registrationForm').onsubmit = submitRegistration;

		// Admin Buttons
		document.getElementById('saveRegSettingsBtn').onclick = saveRegistrationSettings;
		document.getElementById('closeAdminRegModal').onclick = () => document.getElementById('adminRegistrationModal').classList.remove('active');
	}

	async function openRegistrationModal() {
		// Datenbank Check
		if (!window.dbFunctions) {
			showToast("Lade Datenbank... Bitte einen Moment Geduld.", "warning");
			let checkCount = 0;
			const waitForDb = async () => {
				if (window.dbFunctions) {
					await openRegistrationModal();
				} else if (checkCount < 20) {
					checkCount++;
					setTimeout(waitForDb, 200);
				} else {
					showToast("Datenbank Verbindung fehlgeschlagen. Seite neu laden?", "danger"); // Datenbank nicht bereit Fehlermeldung
				}
			};
			await waitForDb();
			return;
		}

		// Admin darf immer verwalten
		if (state.isAdmin) {
			loadRegistrationSettings();
			viewRegistrationList();
			document.getElementById('adminRegistrationModal').classList.add('active');
			return;
		}

		// User checkt Status
		const { doc, getDoc, getDocs, collection } = window.dbFunctions;
		try {
			document.getElementById('regOpenContent').classList.add('hidden');
			document.getElementById('regClosedContent').classList.add('hidden');
			document.getElementById('regModalTitle').textContent = "Lade Status...";
			document.getElementById('registrationModal').classList.add('active');

			const settingsSnap = await getDoc(doc(window.db, CONFIG.REGISTRATIONS_COL, CONFIG.REG_SETTINGS_DOC));
			const settings = settingsSnap.exists() ? settingsSnap.data() : { active: false };

			const regsSnap = await getDocs(collection(window.db, CONFIG.REGISTRATIONS_COL));
			const currentCount = regsSnap.docs.filter(d => d.id !== CONFIG.REG_SETTINGS_DOC).length;

			const now = Date.now();
			const deadlineDate = settings.deadline ? new Date(settings.deadline).getTime() : Infinity;

			let isClosed = !settings.active;
			let reason = "Die Anmeldung wurde vom Administrator deaktiviert.";

			if (settings.active) {
				if (now > deadlineDate) {
					isClosed = true;
					reason = "Der Anmeldeschluss ist bereits erreicht.";
				} else if (currentCount >= (settings.maxParticipants || Infinity)) {
					isClosed = true;
					reason = "Die maximale Teilnehmeranzahl wurde bereits erreicht.";
				}
			}

			document.getElementById('regModalTitle').textContent = "📝 Turnieranmeldung";

			// Deadline anzeigen (wenn vorhanden)
			if (settings.deadline) {
				const dateStr = new Date(settings.deadline).toLocaleString('de-DE');
				document.getElementById('regDeadlineInfo').textContent = `Anmeldeschluss: ${dateStr}`;
				document.getElementById('regDeadlineInfo').classList.remove('hidden');
			} else {
				document.getElementById('regDeadlineInfo').textContent = "";
				document.getElementById('regDeadlineInfo').classList.add('hidden');
			}

			// Teilnehmeranzahl anzeigen (z.B. 1/32) mit Farben je nach Anzahl
			const maxParticipants = settings.maxParticipants || Infinity;
			const maxDisplay = maxParticipants === Infinity ? "∞" : maxParticipants;
			const countEl = document.getElementById('regCountInfo');
			countEl.textContent = `Angemeldet: ${currentCount} / ${maxDisplay}`;

			// Farbe basierend auf Anzahl
			if (currentCount >= maxParticipants) {
				countEl.style.color = 'var(--danger)'; // Rot -> wenn voll
			} else if (currentCount >= maxParticipants * 0.8) {
				countEl.style.color = 'var(--warning)'; // Gelb -> wenn fast voll (80%+)
			} else {
				countEl.style.color = 'var(--success)'; // Grün -> wenn noch viele Plätze frei sind
			}

			if (isClosed) {
				document.getElementById('regOpenContent').classList.add('hidden');
				document.getElementById('regClosedContent').classList.remove('hidden');
				document.getElementById('regClosedReason').textContent = reason;
			} else {
				document.getElementById('regOpenContent').classList.remove('hidden');
				document.getElementById('regClosedContent').classList.add('hidden');
			}
		} catch (e) {
			console.error(e);
			showToast("Fehler beim Laden der Anmeldedaten", "danger");
			document.getElementById('registrationModal').classList.remove('active');
		}
	}

	async function submitRegistration(e) {
		e.preventDefault();
		const nickname = document.getElementById('regNickname').value.trim();

		if (!nickname) {
			showToast("Bitte ein Kürzel eingeben", "danger");
			return;
		}

		try {
			const { doc, setDoc, getDoc, getDocs, collection } = window.dbFunctions;
			const settingsSnap = await getDoc(doc(window.db, CONFIG.REGISTRATIONS_COL, CONFIG.REG_SETTINGS_DOC));
			const settings = settingsSnap.exists() ? settingsSnap.data() : { active: false };

			if (!settings.active) {
				showToast("Anmeldung ist mittlerweile geschlossen.", "danger");
				return;
			}

			const regsSnap = await getDocs(collection(window.db, CONFIG.REGISTRATIONS_COL));
			const currentCount = regsSnap.docs.filter(d => d.id !== CONFIG.REG_SETTINGS_DOC).length;

			if (currentCount >= (settings.maxParticipants || Infinity)) {
				showToast("Leider voll!", "danger");
				return;
			}

			const regId = 'reg_' + Date.now();
			await setDoc(doc(window.db, CONFIG.REGISTRATIONS_COL, regId), {
				nickname: encryptName(nickname),
				registeredAt: Date.now()
			});

			showToast("Anmeldung erfolgreich!", "success");
			document.getElementById('registrationModal').classList.remove('active');
			document.getElementById('registrationForm').reset();
		} catch (e) {
			console.error(e);
			showToast("Fehler beim Anmelden", "danger");
		}
	}

	async function loadRegistrationSettings() {
		if (!requireAdmin()) return;
		const { doc, getDoc, getDocs, collection } = window.dbFunctions;
		try {
			const settingsSnap = await getDoc(doc(window.db, CONFIG.REGISTRATIONS_COL, CONFIG.REG_SETTINGS_DOC));
			const settings = settingsSnap.exists() ? settingsSnap.data() : { active: false, maxParticipants: 32 };

			document.getElementById('regActiveToggle').checked = settings.active;
			document.getElementById('regDeadlineInput').value = settings.deadline || "";
			document.getElementById('regMaxParticipants').value = settings.maxParticipants || 32;

			const regsSnap = await getDocs(collection(window.db, CONFIG.REGISTRATIONS_COL));
			const count = regsSnap.docs.filter(d => d.id !== CONFIG.REG_SETTINGS_DOC).length;

			document.getElementById('regCurrentCount').textContent = count;
			document.getElementById('regLimitDisplay').textContent = settings.maxParticipants || "Kein Limit";
			document.getElementById('regDeadlineDisplay').textContent = settings.deadline ? new Date(settings.deadline).toLocaleString('de-DE') : "Keine Deadline";
		} catch (e) {
			console.error(e);
		}
	}

	async function saveRegistrationSettings() {
		if (!requireAdmin()) return;
		const active = document.getElementById('regActiveToggle').checked;
		const deadline = document.getElementById('regDeadlineInput').value;
		const maxParticipants = parseInt(document.getElementById('regMaxParticipants').value) || 32;

		try {
			const { doc, setDoc } = window.dbFunctions;
			await setDoc(doc(window.db, CONFIG.REGISTRATIONS_COL, CONFIG.REG_SETTINGS_DOC), {
				active,
				deadline,
				maxParticipants
			});
			showToast("Einstellungen gespeichert", "success");
			loadRegistrationSettings();
		} catch (e) {
			console.error(e);
			showToast("Fehler beim Speichern", "danger");
		}
	}

	async function viewRegistrationList() {
		if (!requireAdmin()) return;
		const list = document.getElementById('registeredUsersList');
		list.innerHTML = '<p style="text-align:center; padding:10px;">Lade Liste...</p>';

		try {
			const { collection, getDocs, deleteDoc, doc } = window.dbFunctions;
			const snap = await getDocs(collection(window.db, CONFIG.REGISTRATIONS_COL));

			const regs = snap.docs
				.filter(d => d.id !== CONFIG.REG_SETTINGS_DOC)
				.map(d => ({ id: d.id, ...d.data() }))
				.sort((a, b) => a.registeredAt - b.registeredAt);

			list.innerHTML = "";
			if (regs.length === 0) {
				list.innerHTML = '<p style="text-align:center; color:var(--text-dim); padding:10px;">Noch keine Anmeldungen.</p>';
				return;
			}

			regs.forEach((reg, index) => {
				const div = document.createElement('div');
				div.className = 'participant-item';

				const nameDiv = document.createElement('div');
				const displayName = reg.nickname
					? decryptName(reg.nickname)
					: `${decryptName(reg.firstName)} ${decryptName(reg.lastName)}`;
				nameDiv.innerHTML = `<b>${index + 1}. ${displayName}</b><br><small style="color:var(--text-dim)">${new Date(reg.registeredAt).toLocaleString('de-DE')}</small>`;

				const delBtn = document.createElement('button');
				delBtn.className = 'btn btn-danger small';
				delBtn.innerHTML = '🗑️';
				delBtn.onclick = async () => {
					showCustomDialog({
						title: "Anmeldung löschen?",
						message: `Möchtest du die Anmeldung von ${displayName} wirklich entfernen?`,
						confirmText: "Löschen",
						onConfirm: async () => {
							await deleteDoc(doc(window.db, CONFIG.REGISTRATIONS_COL, reg.id));
							showToast("Anmeldung entfernt", "success");
							viewRegistrationList();
							loadRegistrationSettings();
						}
					});
				};

				div.appendChild(nameDiv);
				div.appendChild(delBtn);
				list.appendChild(div);
			});
		} catch (e) {
			console.error(e);
			list.innerHTML = '<p style="color:var(--danger);">Fehler beim Laden.</p>';
		}
	}

	/**
	 * ============================================================
	 * 13. SPIELPLANUNG
	 * ============================================================
	 */

	function initGamePlanning() {
		const gpBtn = document.getElementById('gamePlanningBtn');
		if (gpBtn) gpBtn.onclick = openGamePlanningModal;

		document.getElementById('closeGamePlanningModal').onclick = () => document.getElementById('gamePlanningModal').classList.remove('active');
		document.getElementById('openAddGameBtn').onclick = () => {
			document.getElementById('addGameForm').reset();
			const searchInput = document.getElementById('matchPickerSearch');
			if (searchInput) searchInput.value = '';
			document.getElementById('gameTitleInput').value = ""; // Reset hidden input
			const display = document.getElementById('selectedMatchDisplay');
			if (display) {
				display.textContent = "";
				display.style.display = "none";
			}
			document.getElementById('gameDateInput').value = state.selectedDate;
			document.getElementById('overlapWarning').classList.add('hidden');
			updateMatchPicker(); // Liste der Spiele aus den Brackets laden
			document.getElementById('addGameModal').classList.add('active');
		};
		document.getElementById('closeAddGameModal').onclick = () => document.getElementById('addGameModal').classList.remove('active');

		document.getElementById('addGameForm').onsubmit = savePlannedGame;

		// Echtzeit validierung
		const inputs = ['gameDateInput', 'gameTimeInput', 'gameDurationInput'];
		inputs.forEach(id => {
			document.getElementById(id).addEventListener('input', validateGameForm);
		});

		const searchInput = document.getElementById('matchPickerSearch');
		if (searchInput) {
			searchInput.oninput = (e) => {
				updateMatchPicker(e.target.value);
			};
		}

		// Spielplanung initialisieren
		const dateInput = document.getElementById('gameDateInput');
		if (dateInput) {
			dateInput.min = new Date().toISOString().split('T')[0];
		}

		// Live Syncronisation der Spiele
		if (window.dbFunctions) {
			const { collection, onSnapshot, query } = window.dbFunctions;
			onSnapshot(collection(window.db, CONFIG.GAMES_COL), (snapshot) => {
				state.plannedGames = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

				// Spiele von vergangenen Tagen löschen
				const today = new Date().toISOString().split('T')[0];
				const { doc, deleteDoc } = window.dbFunctions;
				state.plannedGames.forEach(async (game) => {
					if (game.date < today) {
						console.log("Cleanup: Lösche veraltetes Spiel:", game.title, game.date);
						await deleteDoc(doc(window.db, CONFIG.GAMES_COL, game.id)).catch(e => console.error(e));
					}
				});

				renderCalendar();
				showGamesForDate(state.selectedDate);
				if (!isSavingGame) validateGameForm(); // Nur validieren, wenn nicht gespeichert wird
			});
		}
	}

	// Auswahl der Matches
	function updateMatchPicker(filterText = '') {
		const container = document.getElementById('matchPickerContainer');
		const hiddenInput = document.getElementById('gameTitleInput');
		const display = document.getElementById('selectedMatchDisplay');
		if (!container || !state.tournament) return;
		container.innerHTML = '';

		const matches = [];
		const t = state.tournament;

		const extractFromMatch = (m) => {
			if (m.completed) return;
			const p1 = m.player1;
			const p2 = m.player2;
			const p1b = TournamentManager.isBye(p1);
			const p2b = TournamentManager.isBye(p2);

			// Nur Spiele hinzufügen, in denen beide Spieler echt sind (kein TBD)
			const isP1Real = p1 && !p1b && p1 !== 'TBD';
			const isP2Real = p2 && !p2b && p2 !== 'TBD';

			if (isP1Real && isP2Real) {
				if (m.type === 'group') {
					let foundGroup = null;
					if (m.groupIndex !== undefined && t.groups[m.groupIndex]) {
						foundGroup = t.groups[m.groupIndex];
					} else {
						foundGroup = t.groups.find(g => g.matches && g.matches.some(match => match.id === m.id));
					}
					const groupTitle = foundGroup ? foundGroup.title : "Gruppenspiel";
					matches.push(`${p1} vs. ${p2} (${groupTitle})`);
				} else {
					matches.push(`${p1} vs. ${p2}`);
				}
			}
		};

		// Brackets durchsuchen
		t.winnerBracket.forEach(r => r.forEach(extractFromMatch));
		t.loserBracket.forEach(r => r.forEach(extractFromMatch));
		t.stepladder.forEach(extractFromMatch);

		// Gruppenphase durchsuchen
		if (t.groups && t.groups.length > 0) {
			t.groups.forEach(g => {
				if (g.matches) {
					g.matches.forEach(extractFromMatch);
				}
			});
		}

		if (matches.length === 0) {
			container.innerHTML = '<p style="text-align:center; color:var(--text-dim); padding:10px;">Keine offenen Spiele verfügbar.</p>';
			return;
		}

		// Doppelte Prüfung: Nur unique Einträge
		const uniqueMatches = [...new Set(matches)].sort();

		const filteredMatches = uniqueMatches.filter(m => m.toLowerCase().includes(filterText.toLowerCase()));

		if (filteredMatches.length === 0) {
			container.innerHTML = '<p style="text-align:center; color:var(--text-dim); padding:10px;">Keine passenden Spiele verfügbar.</p>';
			return;
		}

		filteredMatches.forEach(matchText => {
			// Bereits geplante spiele überspringen
			const isAlreadyPlanned = state.plannedGames && state.plannedGames.some(g => g.title.startsWith(matchText));
			if (isAlreadyPlanned) return;

			const div = document.createElement('div');
			div.className = 'match-picker-item';
			div.textContent = matchText;
			div.onclick = () => {
				container.querySelectorAll('.match-picker-item').forEach(el => el.classList.remove('selected'));
				div.classList.add('selected');
				// Wert speichern
				hiddenInput.value = matchText;
				// Anzeige aktualisieren
				if (display) {
					display.textContent = `Ausgewählt: ${matchText}`;
					display.style.display = "block";
				}
			};
			container.appendChild(div);
		});
	}

	// Validierung
	function validateGameForm() {
		if (isSavingGame) return; // Abbruch wenn gerade gespeichert wird
		const date = document.getElementById('gameDateInput').value;
		const time = document.getElementById('gameTimeInput').value;
		const duration = document.getElementById('gameDurationInput').value;
		const warning = document.getElementById('overlapWarning');
		const saveBtn = document.querySelector('#addGameForm button[type="submit"]');

		if (!date || !time) {
			warning.classList.add('hidden');
			if (saveBtn) saveBtn.disabled = false;
			return;
		}

		const dummyGame = { id: 'temp', time, duration };
		const dayGames = state.plannedGames.filter(g => g.date === date);
		const hasOverlap = checkOverlapLogic(dummyGame, dayGames);

		//Turnier überlapungs Prüfung
		if (hasOverlap) {
			warning.classList.remove('hidden');
			if (saveBtn) {
				saveBtn.disabled = true;
				saveBtn.style.opacity = '0.5';
				saveBtn.style.cursor = 'not-allowed';
				saveBtn.textContent = '❌ Konflikt erkannt';  // Speicher Button ändern
			}
		} else {
			warning.classList.add('hidden');
			if (saveBtn) {
				saveBtn.disabled = false;
				saveBtn.style.opacity = '1';
				saveBtn.style.cursor = 'pointer';
				saveBtn.textContent = 'Speichern';
			}
		}
	}

	// Planungs UI anzeigen
	function openGamePlanningModal() {
		document.getElementById('gamePlanningModal').classList.add('active');
		renderCalendar();
		showGamesForDate(state.selectedDate);
	}

	// Kalender Laden
	function renderCalendar() {
		const container = document.getElementById('calendarContainer');
		if (!container) return;
		container.innerHTML = '';

		const month = state.currentCalendarMonth;
		const year = month.getFullYear();
		const mIdx = month.getMonth();
		const monthName = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' }).format(month);

		// Überschrift
		const header = document.createElement('div');
		header.className = 'calendar-header';

		// Navigation einschränken (vergangene Monate nicht anzeigen)
		const now = new Date();
		const isCurrentMonth = month.getFullYear() === now.getFullYear() && month.getMonth() === now.getMonth();

		header.innerHTML = `
        <button class="btn btn-outline small" id="prevMonth" ${isCurrentMonth ? 'disabled style="opacity:0.3; cursor:not-allowed;"' : ''}>◀</button>
        <span style="font-weight: 800;">${monthName}</span>
        <button class="btn btn-outline small" id="nextMonth">▶</button>
    `;
		container.appendChild(header);

		if (!isCurrentMonth) {
			header.querySelector('#prevMonth').onclick = () => {
				state.currentCalendarMonth.setMonth(state.currentCalendarMonth.getMonth() - 1);
				renderCalendar();
			};
		}
		header.querySelector('#nextMonth').onclick = () => {
			state.currentCalendarMonth.setMonth(state.currentCalendarMonth.getMonth() + 1);
			renderCalendar();
		};

		// Grid
		const grid = document.createElement('div');
		grid.className = 'calendar-grid';

		// Wochentage
		['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].forEach(d => {
			const div = document.createElement('div');
			div.className = 'calendar-weekday';
			div.textContent = d;
			grid.appendChild(div);
		});

		// Tage
		const firstDay = new Date(year, mIdx, 1).getDay(); // 0(Sun) to 6(Sat)
		const adjFirstDay = firstDay === 0 ? 6 : firstDay - 1; // 0(Mon) to 6(Sun)
		const daysInMonth = new Date(year, mIdx + 1, 0).getDate();

		// Anzeige der Vormonate
		const prevDaysInMonth = new Date(year, mIdx, 0).getDate();
		for (let i = adjFirstDay - 1; i >= 0; i--) {
			const div = document.createElement('div');
			div.className = 'calendar-day prev-month';
			div.textContent = prevDaysInMonth - i;
			grid.appendChild(div);
		}

		// Aktueller Tag
		const today = new Date().toISOString().split('T')[0];
		for (let d = 1; d <= daysInMonth; d++) {
			const dateStr = `${year}-${String(mIdx + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
			const div = document.createElement('div');
			div.className = 'calendar-day';

			const isPast = dateStr < today;
			if (isPast) div.classList.add('past-day');

			if (dateStr === today) div.classList.add('today');
			if (dateStr === state.selectedDate) div.classList.add('selected');

			// Prüfen ob an dem Tag ein Spiel stattfindet
			const hasGames = state.plannedGames.some(g => g.date === dateStr);
			if (hasGames) div.classList.add('has-games');

			div.textContent = d;

			if (!isPast) {
				div.onclick = () => {
					state.selectedDate = dateStr;
					renderCalendar();
					showGamesForDate(dateStr);
				};
			}

			grid.appendChild(div);
		}

		// Anzeige der nächsten Monate
		let cellsSoFar = grid.children.length;
		let nextMonthDay = 1;
		while (cellsSoFar % 7 !== 0 || cellsSoFar < 49) {
			const div = document.createElement('div');
			div.className = 'calendar-day next-month';
			div.textContent = nextMonthDay++;
			grid.appendChild(div);
			cellsSoFar++;
			if (cellsSoFar >= 49) break;
		}

		container.appendChild(grid);
	}

	// Spiele für den Tag anzeigen
	function showGamesForDate(dateStr) {
		const list = document.getElementById('dailyGamesList');
		const title = document.getElementById('selectedDateTitle');
		const countEl = document.getElementById('dailyGamesCount');
		if (!list || !title) return;

		const dateObj = new Date(dateStr);
		const dayName = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: '2-digit', month: 'long' }).format(dateObj);
		title.textContent = dayName;

		const dayGames = state.plannedGames
			.filter(g => g.date === dateStr)
			.sort((a, b) => a.time.localeCompare(b.time));

		if (countEl) {
			countEl.textContent = `${dayGames.length} ${dayGames.length === 1 ? 'Spiel' : 'Spiele'}`;
		}

		list.innerHTML = '';
		if (dayGames.length === 0) {
			list.innerHTML = '<p style="text-align: center; color: var(--text-dim); padding: 40px;">Keine Spiele für diesen Tag geplant.</p>';
			return;
		}

		dayGames.forEach(game => {
			const hasOverlap = checkOverlapLogic(game, dayGames);
			const div = document.createElement('div');
			div.className = `game-item ${hasOverlap ? 'overlap' : ''}`;

			div.innerHTML = `
            <div class="game-info-col">
                <span class="game-time">${game.time} Uhr</span>
                <span class="game-title">${game.title}</span>
                <span class="game-duration">⏱️ ${game.duration} Min</span>
                ${hasOverlap ? '<span class="game-overlap-badge">⚠️ Überschneidung</span>' : ''} 
            </div>
        `;

			// Geplante spiele löschen button
			if (state.isAdmin) {
				const delBtn = document.createElement('button');
				delBtn.className = 'btn btn-danger small';
				delBtn.innerHTML = '🗑️';
				delBtn.onclick = () => deletePlannedGame(game.id);
				div.appendChild(delBtn);
			}

			list.appendChild(div);
		});
	}

	// Prüfung für Überlapen
	function checkOverlapLogic(game, allDayGames) {
		const start1 = timeToMinutes(game.time);
		const end1 = start1 + parseInt(game.duration);

		return allDayGames.some(other => {
			if (other.id === game.id) return false;
			const start2 = timeToMinutes(other.time);
			const end2 = start2 + parseInt(other.duration);

			return (start1 < end2 && end1 > start2);
		});
	}

	function timeToMinutes(timeStr) {
		const [h, m] = timeStr.split(':').map(Number);
		return h * 60 + m;
	}

	// Speichern der geplanten Spiele
	async function savePlannedGame(e) {
		e.preventDefault();
		const date = document.getElementById('gameDateInput').value;
		const time = document.getElementById('gameTimeInput').value;
		const duration = document.getElementById('gameDurationInput').value;
		const title = document.getElementById('gameTitleInput').value.trim();

		const todayStr = new Date().toISOString().split('T')[0];

		if (!date || !time || !title) return;

		if (date < todayStr) {
			showToast("Spiele können nicht in der Vergangenheit geplant werden!", "danger");
			return;
		}

		// Überlapungs check
		const dummyGame = { id: 'temp', time, duration };
		const dayGames = state.plannedGames.filter(g => g.date === date);
		const hasOverlap = checkOverlapLogic(dummyGame, dayGames);

		if (hasOverlap) {
			showToast("Speichern nicht möglich: Zeitlicher Konflikt!", "danger");
			validateGameForm(); // Refresh UI state
			return;
		}

		const warning = document.getElementById('overlapWarning');
		if (warning) warning.classList.add('hidden');

		isSavingGame = true;
		try {
			const { doc, setDoc } = window.dbFunctions;
			const id = 'game_' + Date.now();
			await setDoc(doc(window.db, CONFIG.GAMES_COL, id), {
				date,
				time,
				duration,
				title,
				createdBy: state.currentUser.username,
				createdAt: Date.now()
			});

			showToast("Spiel erfolgreich geplant!", "success");
			document.getElementById('addGameModal').classList.remove('active');
			state.selectedDate = date;
			renderCalendar();
			showGamesForDate(date);
		} catch (e) {
			console.error(e);
			showToast("Fehler beim Speichern.", "danger");
		} finally {
			setTimeout(() => { isSavingGame = false; }, 500);
		}
	}

	//Geplante Spiele löschen 
	async function deletePlannedGame(id) {
		if (!requireAdmin()) return;
		showCustomDialog({
			title: "Spiel löschen?",
			message: "Möchtest du dieses geplante Spiel wirklich entfernen?",
			confirmText: "Löschen",
			onConfirm: async () => {
				try {
					const { doc, deleteDoc } = window.dbFunctions;
					await deleteDoc(doc(window.db, CONFIG.GAMES_COL, id));
					showToast("Spiel gelöscht.", "success");
				} catch (e) {
					console.error(e);
					showToast("Fehler beim Löschen.", "danger"); //Fehlermeldung
				}
			}
		});
	}
	window.deletePlannedGame = deletePlannedGame;
})();