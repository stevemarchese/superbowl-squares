let gameData = { squares: [], config: {} };
let isAdmin = false;
let squaresLimit = 5;
let selectedSquare = null;
let selectedSquares = [];
let currentGridId = 1;
let gridsData = [];
let participantsFilter = 'all';
let participantsSort = 'name';
let participantsSearch = '';
let allParticipants = [];
let claimDeadline = null;
let deadlineInterval = null;
let selectedParticipants = new Set();
let auditLogPage = 1;
let auditLogFilter = '';
let auditLogSearch = '';
let liveScoresInterval = null;
let liveSyncEnabled = false;
let lockedQuarters = { q1: false, q2: false, q3: false, q4: false };

// Body scroll lock for modals (prevents iOS viewport issues)
function lockBodyScroll() {
    document.body.classList.add('modal-open');
}

function unlockBodyScroll() {
    document.body.classList.remove('modal-open');
}

// Initialize the app
document.addEventListener('DOMContentLoaded', async () => {
    await checkAdminStatus();
    await loadGrids();
    await loadGrid();
    await loadLogos();
});

async function checkAdminStatus() {
    try {
        const response = await fetch('/api/admin/status');
        const data = await response.json();
        isAdmin = data.is_admin;

        if (isAdmin) {
            const adminLink = document.getElementById('adminLink');
            if (adminLink) adminLink.style.display = 'none';
            document.getElementById('logoutBtn').style.display = 'inline-block';
            document.querySelectorAll('.admin-only').forEach(el => {
                el.classList.add('visible');
            });
            // Hide elements that should be hidden for admin
            document.querySelectorAll('.hide-for-admin').forEach(el => {
                el.classList.add('hidden');
            });
            // Load participant data for admin
            loadParticipants();
            loadPlayerTotals();
            // Initialize live scores
            initLiveScores();
        }
        // Re-render tabs to show/hide add button
        renderGridTabs();
    } catch (error) {
        console.error('Error checking admin status:', error);
    }
}

// Accordion toggle function
function toggleAccordion(sectionId) {
    const section = document.getElementById(sectionId);
    if (!section) return;

    const isOpen = section.classList.contains('open');

    // Close all sections
    document.querySelectorAll('.accordion-section').forEach(s => {
        s.classList.remove('open');
    });

    // Open clicked section if it was closed
    if (!isOpen) {
        section.classList.add('open');
    }
}

async function adminLogout() {
    try {
        await fetch('/api/admin/logout', { method: 'POST' });
        window.location.reload();
    } catch (error) {
        console.error('Error logging out:', error);
    }
}

async function loadGrids() {
    try {
        const response = await fetch('/api/grids');
        const data = await response.json();
        gridsData = data.grids || [];
        renderGridTabs();
    } catch (error) {
        console.error('Error loading grids:', error);
    }
}

function renderGridTabs() {
    const tabsContainer = document.getElementById('gridTabs');
    const tabsWrapper = document.querySelector('.grid-tabs-container');
    if (!tabsContainer) return;

    tabsContainer.innerHTML = '';

    // Hide tabs if only 1 grid and not admin
    if (gridsData.length <= 1 && !isAdmin) {
        if (tabsWrapper) tabsWrapper.style.display = 'none';
        return;
    }

    // Show tabs container
    if (tabsWrapper) tabsWrapper.style.display = 'block';

    gridsData.forEach(grid => {
        const tab = document.createElement('div');
        tab.className = 'grid-tab-wrapper';

        const tabBtn = document.createElement('button');
        tabBtn.className = 'grid-tab' + (grid.id === currentGridId ? ' active' : '');
        tabBtn.textContent = `${grid.name} (${grid.squares_sold}/100)`;
        tabBtn.onclick = () => switchGrid(grid.id);
        tab.appendChild(tabBtn);

        // Add delete button for admin (except grid 1)
        if (isAdmin && grid.id !== 1) {
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'grid-delete-btn';
            deleteBtn.textContent = '×';
            deleteBtn.title = 'Delete this grid';
            deleteBtn.onclick = (e) => {
                e.stopPropagation();
                deleteGrid(grid.id, grid.name);
            };
            tab.appendChild(deleteBtn);
        }

        tabsContainer.appendChild(tab);
    });

    // Add "Add Grid" button for admin
    if (isAdmin) {
        const addBtn = document.createElement('button');
        addBtn.className = 'grid-tab add-grid-btn';
        addBtn.textContent = '+';
        addBtn.title = 'Add new grid';
        addBtn.onclick = createNewGrid;
        tabsContainer.appendChild(addBtn);
    }
}

async function switchGrid(gridId) {
    currentGridId = gridId;
    selectedSquares = [];
    updateSelectedDisplay();
    await loadGrid();
}

async function deleteGrid(gridId, gridName) {
    if (!confirm(`Are you sure you want to delete "${gridName}"? This will remove all squares in this grid and cannot be undone.`)) {
        return;
    }

    try {
        const response = await fetch(`/api/admin/grids/${gridId}`, {
            method: 'DELETE'
        });
        const result = await response.json();
        if (result.error) {
            alert(result.error);
        } else {
            // If we deleted the current grid, switch to grid 1
            if (currentGridId === gridId) {
                currentGridId = 1;
            }
            await loadGrids();
            await loadGrid();
        }
    } catch (error) {
        console.error('Error deleting grid:', error);
    }
    renderGridTabs();
}

async function createNewGrid() {
    const name = prompt('Enter name for new grid (or leave blank for auto-name):');
    if (name === null) return; // cancelled

    try {
        const response = await fetch('/api/admin/grids', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name.trim() })
        });
        const result = await response.json();
        if (result.error) {
            alert(result.error);
        } else {
            await loadGrids();
            switchGrid(result.grid_id);
        }
    } catch (error) {
        console.error('Error creating grid:', error);
    }
}

async function loadGrid() {
    try {
        const response = await fetch(`/api/grid?grid_id=${currentGridId}`);
        const data = await response.json();
        gameData = data;
        squaresLimit = data.squares_limit || 5;
        claimDeadline = data.claim_deadline ? new Date(data.claim_deadline) : null;

        // Update both admin and public limit displays
        const limitPublic = document.getElementById('squaresLimitPublic');
        if (limitPublic) limitPublic.textContent = squaresLimit;
        const limitInput = document.getElementById('squaresLimitInput');
        if (limitInput) limitInput.value = squaresLimit;

        // Update deadline input for admin
        const deadlineInput = document.getElementById('claimDeadlineInput');
        if (deadlineInput && data.claim_deadline) {
            // Format for datetime-local input (YYYY-MM-DDTHH:MM)
            deadlineInput.value = data.claim_deadline.slice(0, 16);
        }

        // Update locked quarters state from grid data
        if (data.locked_quarters) {
            lockedQuarters = {
                q1: data.locked_quarters.q1,
                q2: data.locked_quarters.q2,
                q3: data.locked_quarters.q3,
                q4: data.locked_quarters.q4
            };
        }

        // Update live sync state
        if (typeof data.live_sync_enabled !== 'undefined') {
            liveSyncEnabled = data.live_sync_enabled;
            const liveSyncToggle = document.getElementById('liveSyncToggle');
            if (liveSyncToggle) liveSyncToggle.checked = liveSyncEnabled;
        }

        renderGrid();
        renderNumbers();
        loadConfig();
        updateStats();
        highlightWinners();
        restoreHighlightedSquares();
        updateDeadlineBanner();

        // Update quarter lock UI if admin
        if (isAdmin) {
            updateQuarterLockUI();
        }
    } catch (error) {
        console.error('Error loading grid:', error);
    }
}

function renderGrid() {
    const grid = document.getElementById('grid');
    grid.innerHTML = '';
    const price = parseFloat(gameData.config.price_per_square) || 10;

    const isMobile = window.innerWidth <= 480;

    for (let row = 0; row < 10; row++) {
        for (let col = 0; col < 10; col++) {
            const square = gameData.squares.find(s => s.row === row && s.col === col);
            const div = document.createElement('div');
            div.className = 'square';
            div.dataset.row = row;
            div.dataset.col = col;

            if (square && square.owner_name) {
                // On mobile, show initials only
                if (isMobile) {
                    div.textContent = getInitials(square.owner_name);
                } else {
                    // Split name to put first/last on separate lines
                    div.innerHTML = formatNameForSquare(square.owner_name);
                }
                div.classList.add('claimed');
            } else {
                // On mobile, show just $ instead of $20
                const priceDisplay = isMobile ? '$' : `$${price.toFixed(0)}`;
                div.textContent = priceDisplay;
                div.classList.add('available');
                div.dataset.price = priceDisplay;
                // Check if claiming is allowed (numbers not locked AND deadline not passed)
                const claimingOpen = (!gameData.config.numbers_locked && (!claimDeadline || new Date() < claimDeadline)) || isAdmin;
                if (claimingOpen) {
                    div.addEventListener('mouseenter', () => {
                        div.innerHTML = 'Click to<br>claim';
                    });
                    div.addEventListener('mouseleave', () => {
                        div.textContent = div.dataset.price;
                    });
                } else {
                    div.classList.add('locked');
                }
            }

            div.addEventListener('click', () => handleSquareClick(row, col, square));
            grid.appendChild(div);
        }
    }
}

// Get first and last initials from a name
function getInitials(name) {
    if (!name) return '';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) {
        return parts[0].charAt(0).toUpperCase();
    }
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

// Format name with smart line breaks for squares
function formatNameForSquare(name) {
    if (!name) return '';
    const maxChars = 10;
    const parts = name.trim().split(/\s+/);

    // Helper to break long words
    function breakLongWord(word) {
        if (word.length <= maxChars) return escapeHtml(word);
        // Break into chunks of maxChars
        let result = '';
        for (let i = 0; i < word.length; i += maxChars) {
            if (i > 0) result += '<br>';
            result += escapeHtml(word.slice(i, i + maxChars));
        }
        return result;
    }

    if (parts.length === 1) {
        return breakLongWord(parts[0]);
    }

    // If first name is short enough, put last name on next line
    const firstName = parts[0];
    const lastName = parts.slice(1).join(' ');

    if (firstName.length <= maxChars) {
        return escapeHtml(firstName) + '<br>' + breakLongWord(lastName);
    } else {
        // First name is too long, break it too
        return breakLongWord(firstName) + '<br>' + breakLongWord(lastName);
    }
}

function handleSquareClick(row, col, square) {
    // Disable claiming once numbers are locked (except for admin)
    if (gameData.config.numbers_locked && !isAdmin) {
        alert('Claiming is closed. Numbers have been locked.');
        return;
    }

    // Check if deadline has passed (except for admin)
    if (!isAdmin && claimDeadline && new Date() > claimDeadline) {
        alert('The claiming deadline has passed.');
        return;
    }

    if (square && square.owner_name) {
        // Square is claimed
        if (isAdmin) {
            // Admin can clear it
            openAdminClearModal(row, col, square.owner_name);
        } else {
            alert(`This square is already claimed by ${square.owner_name}`);
        }
        return;
    }

    // Toggle selection for multi-select
    const existingIndex = selectedSquares.findIndex(s => s.row === row && s.col === col);

    if (existingIndex > -1) {
        // Deselect
        selectedSquares.splice(existingIndex, 1);
    } else {
        // Select (check limit)
        if (selectedSquares.length >= squaresLimit) {
            alert(`You can only select up to ${squaresLimit} squares at a time`);
            return;
        }
        selectedSquares.push({ row, col });
    }

    updateSelectedDisplay();
}

function updateSelectedDisplay() {
    // Update visual state of squares
    document.querySelectorAll('.square').forEach(div => {
        const row = parseInt(div.dataset.row);
        const col = parseInt(div.dataset.col);
        const isSelected = selectedSquares.some(s => s.row === row && s.col === col);
        div.classList.toggle('selected', isSelected);
    });

    // Show/hide claim container and update info
    const claimContainer = document.getElementById('claimSelectedContainer');
    const claimBtn = document.getElementById('claimSelectedBtn');
    const claimLimitInfo = document.getElementById('claimLimitInfo');
    const claimTotalAmount = document.getElementById('claimTotalAmount');

    if (claimContainer) {
        claimContainer.style.display = selectedSquares.length > 0 ? 'flex' : 'none';
    }

    if (claimBtn) {
        claimBtn.innerHTML = `Claim ${selectedSquares.length} Square${selectedSquares.length !== 1 ? 's' : ''} <span class="btn-icon">→</span>`;
    }

    if (claimLimitInfo) {
        claimLimitInfo.textContent = `You may claim ${squaresLimit} boxes max (${selectedSquares.length}/${squaresLimit})`;
    }

    if (claimTotalAmount) {
        const pricePerSquare = parseFloat(gameData.config?.price_per_square) || 10;
        const total = selectedSquares.length * pricePerSquare;
        claimTotalAmount.textContent = `Total: $${total.toFixed(2)}`;
    }
}

function openClaimModalMulti() {
    if (selectedSquares.length === 0) return;

    const squaresList = selectedSquares.map(s => `Row ${s.row}, Col ${s.col}`).join('; ');
    document.getElementById('modalSquaresList').textContent = squaresList;
    document.getElementById('modalSquaresCount').textContent = selectedSquares.length;
    document.getElementById('claimName').value = localStorage.getItem('lastClaimName') || '';
    document.getElementById('claimEmail').value = localStorage.getItem('lastClaimEmail') || '';
    document.getElementById('claimPlayerName').value = localStorage.getItem('lastClaimPlayerName') || '';
    lockBodyScroll();
    document.getElementById('claimModal').classList.add('active');
    document.getElementById('claimName').focus();
}

function openClaimModal(row, col) {
    // Legacy single-select - redirect to multi-select flow
    selectedSquares = [{ row, col }];
    updateSelectedDisplay();
    openClaimModalMulti();
}

function closeModal() {
    document.getElementById('claimModal').classList.remove('active');
    document.getElementById('confirmModal').classList.remove('active');
    unlockBodyScroll();
    selectedSquare = null;
    selectedSquares = [];
    updateSelectedDisplay();
}

function showConfirmation() {
    const name = document.getElementById('claimName').value.trim();
    const email = document.getElementById('claimEmail').value.trim();
    const playerName = document.getElementById('claimPlayerName').value.trim();

    if (!name) {
        alert('Please enter your name');
        return;
    }
    if (!email || !email.includes('@') || !email.includes('.')) {
        alert('Please enter a valid email address');
        return;
    }

    // Save for convenience
    localStorage.setItem('lastClaimName', name);
    localStorage.setItem('lastClaimEmail', email);
    localStorage.setItem('lastClaimPlayerName', playerName);

    // Show confirmation modal
    const squaresList = selectedSquares.map(s => `Row ${s.row}, Col ${s.col}`).join('; ');
    document.getElementById('confirmSquaresList').textContent = squaresList;
    document.getElementById('confirmSquaresCount').textContent = selectedSquares.length;
    document.getElementById('confirmName').textContent = name;
    document.getElementById('confirmEmail').textContent = email;

    // Show player name if provided
    const confirmPlayerNameRow = document.getElementById('confirmPlayerNameRow');
    if (playerName) {
        document.getElementById('confirmPlayerName').textContent = playerName;
        if (confirmPlayerNameRow) confirmPlayerNameRow.style.display = 'block';
    } else {
        if (confirmPlayerNameRow) confirmPlayerNameRow.style.display = 'none';
    }

    // Calculate and show total owed
    const pricePerSquare = parseFloat(gameData.config?.price_per_square) || 10;
    const totalOwed = selectedSquares.length * pricePerSquare;
    document.getElementById('confirmTotalOwed').textContent = `$${totalOwed.toFixed(2)}`;

    document.getElementById('claimModal').classList.remove('active');
    document.getElementById('confirmModal').classList.add('active');
}

function backToDetails() {
    document.getElementById('confirmModal').classList.remove('active');
    document.getElementById('claimModal').classList.add('active');
}

async function submitClaim() {
    const name = document.getElementById('claimName').value.trim();
    const email = document.getElementById('claimEmail').value.trim();
    const playerName = document.getElementById('claimPlayerName').value.trim();

    let successCount = 0;
    let errors = [];

    for (const square of selectedSquares) {
        try {
            const response = await fetch('/api/claim', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    grid_id: currentGridId,
                    row: square.row,
                    col: square.col,
                    name: name,
                    email: email,
                    player_name: playerName
                })
            });

            const result = await response.json();
            if (result.error) {
                errors.push(`Row ${square.row}, Col ${square.col}: ${result.error}`);
            } else {
                successCount++;
            }
        } catch (error) {
            console.error('Error claiming square:', error);
            errors.push(`Row ${square.row}, Col ${square.col}: Network error`);
        }
    }

    closeModal();

    if (successCount > 0) {
        // Show success modal with payment info
        document.getElementById('successSquaresCount').textContent = successCount;
        document.getElementById('successPlural').textContent = successCount !== 1 ? 's' : '';
        const pricePerSquare = parseFloat(gameData.config?.price_per_square) || 10;
        const totalOwed = successCount * pricePerSquare;
        document.getElementById('successTotalOwed').textContent = `$${totalOwed.toFixed(2)}`;
        document.getElementById('successModal').classList.add('active');
    }
    if (errors.length > 0) {
        alert(`Some squares could not be claimed:\n${errors.join('\n')}`);
    }

    await loadGrids();
    loadGrid();
}

function closeSuccessModal() {
    document.getElementById('successModal').classList.remove('active');
    unlockBodyScroll();
}

// Admin functions
function openAdminClearModal(row, col, ownerName) {
    selectedSquare = { row, col };
    document.getElementById('clearRow').textContent = row;
    document.getElementById('clearCol').textContent = col;
    document.getElementById('clearOwnerName').textContent = ownerName;
    lockBodyScroll();
    document.getElementById('adminClearModal').classList.add('active');
}

function closeAdminModal() {
    document.getElementById('adminClearModal').classList.remove('active');
    unlockBodyScroll();
    selectedSquare = null;
}

async function adminClearSquare() {
    try {
        const response = await fetch('/api/admin/clear-square', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                grid_id: currentGridId,
                row: selectedSquare.row,
                col: selectedSquare.col
            })
        });

        const result = await response.json();
        if (result.error) {
            alert(result.error);
        } else {
            closeAdminModal();
            await loadGrids();
            loadGrid();
        }
    } catch (error) {
        console.error('Error clearing square:', error);
    }
}

function renderNumbers() {
    const colNumbers = document.getElementById('colNumbers');
    const rowNumbers = document.getElementById('rowNumbers');

    colNumbers.innerHTML = '';
    rowNumbers.innerHTML = '';

    const colNums = gameData.config.col_numbers || Array(10).fill('?');
    const rowNums = gameData.config.row_numbers || Array(10).fill('?');

    colNums.forEach(num => {
        const div = document.createElement('div');
        div.className = 'number-cell';
        div.textContent = num !== null ? num : '?';
        colNumbers.appendChild(div);
    });

    rowNums.forEach(num => {
        const div = document.createElement('div');
        div.className = 'number-cell';
        div.textContent = num !== null ? num : '?';
        rowNumbers.appendChild(div);
    });

    const randomizeBtn = document.getElementById('randomizeBtn');
    const clearBtn = document.getElementById('clearBtn');
    const lockBtn = document.getElementById('lockBtn');

    if (gameData.config.numbers_locked) {
        if (randomizeBtn) randomizeBtn.disabled = true;
        if (clearBtn) clearBtn.disabled = true;
        if (lockBtn) {
            lockBtn.disabled = true;
            lockBtn.textContent = 'Numbers Locked';
        }
    }
}

function loadConfig() {
    const config = gameData.config;

    const team1Input = document.getElementById('team1');
    const team2Input = document.getElementById('team2');

    if (team1Input) team1Input.value = config.team1_name || '';
    if (team2Input) team2Input.value = config.team2_name || '';

    // Store team names for use with logos
    window.team1Name = config.team1_name || 'Team 1';
    window.team2Name = config.team2_name || 'Team 2';

    // Update labels (logos will be added by loadLogos)
    const team1Label = document.getElementById('team1Label');
    const team2Label = document.getElementById('team2Label');
    team1Label.textContent = window.team1Name;
    team2Label.textContent = window.team2Name;

    // Update score section team labels
    document.querySelectorAll('.score-team1-label').forEach(el => el.textContent = window.team1Name);
    document.querySelectorAll('.score-team2-label').forEach(el => el.textContent = window.team2Name);

    const priceInput = document.getElementById('pricePerSquare');
    if (priceInput && config.price_per_square !== null && config.price_per_square !== undefined) {
        priceInput.value = config.price_per_square;
    }

    ['q1_team1', 'q1_team2', 'q2_team1', 'q2_team2',
     'q3_team1', 'q3_team2', 'q4_team1', 'q4_team2'].forEach(field => {
        const input = document.getElementById(field);
        if (input && config[field] !== null && config[field] !== undefined) {
            input.value = config[field];
        }
    });

    // Load show_winners toggle state
    const showWinnersToggle = document.getElementById('showWinnersToggle');
    if (showWinnersToggle) {
        showWinnersToggle.checked = config.show_winners === 1;
    }

    // Show/hide winners section based on config
    updateWinnersVisibility();

    // Hide claim container if numbers are locked (for non-admin)
    updateClaimContainerVisibility();

    // Load alert banner state
    loadAlertBanner(config);
}

function updateClaimContainerVisibility() {
    const claimContainer = document.getElementById('claimSelectedContainer');
    if (!claimContainer) return;

    // Hide claim container if numbers locked or deadline passed (except for admin)
    const deadlinePassed = claimDeadline && new Date() > claimDeadline;
    if ((gameData.config.numbers_locked || deadlinePassed) && !isAdmin) {
        claimContainer.style.display = 'none';
    }
}

function updateWinnersVisibility() {
    const winnersSection = document.getElementById('winnersSection');
    if (winnersSection) {
        winnersSection.style.display = gameData.config.show_winners === 1 ? 'block' : 'none';
    }
}

async function toggleShowWinners() {
    const showWinnersToggle = document.getElementById('showWinnersToggle');
    const showWinners = showWinnersToggle.checked;

    try {
        const response = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ show_winners: showWinners })
        });

        if (response.ok) {
            gameData.config.show_winners = showWinners ? 1 : 0;
            updateWinnersVisibility();
        }
    } catch (error) {
        console.error('Error toggling show winners:', error);
    }
}

function updateStats() {
    const claimedSquares = gameData.squares.filter(s => s.owner_name).length;
    const pricePerSquare = parseFloat(gameData.config.price_per_square) || 10;
    const totalCollected = claimedSquares * pricePerSquare;

    // Update admin stats (in Grid Administration accordion)
    const squaresSold = document.getElementById('squaresSold');
    if (squaresSold) squaresSold.textContent = `${claimedSquares} / 100`;
    const totalCollectedEl = document.getElementById('totalCollected');
    if (totalCollectedEl) totalCollectedEl.textContent = `$${totalCollected.toFixed(2)}`;

    // Update public stats
    const squaresSoldPublic = document.getElementById('squaresSoldPublic');
    if (squaresSoldPublic) squaresSoldPublic.textContent = `${claimedSquares} / 100`;
    const totalCollectedPublic = document.getElementById('totalCollectedPublic');
    if (totalCollectedPublic) totalCollectedPublic.textContent = `$${totalCollected.toFixed(2)}`;

    // Calculate prize amounts
    const prizeQ1Pct = parseFloat(gameData.config.prize_q1) || 10;
    const prizeQ2Pct = parseFloat(gameData.config.prize_q2) || 10;
    const prizeQ3Pct = parseFloat(gameData.config.prize_q3) || 10;
    const prizeQ4Pct = parseFloat(gameData.config.prize_q4) || 20;
    const charityPct = 100 - prizeQ1Pct - prizeQ2Pct - prizeQ3Pct - prizeQ4Pct;

    const prizeQ1 = totalCollected * (prizeQ1Pct / 100);
    const prizeQ2 = totalCollected * (prizeQ2Pct / 100);
    const prizeQ3 = totalCollected * (prizeQ3Pct / 100);
    const prizeQ4 = totalCollected * (prizeQ4Pct / 100);
    const charityAmount = totalCollected * (charityPct / 100);

    // Update prize display
    document.getElementById('prizeQ1').textContent = `$${prizeQ1.toFixed(0)}`;
    document.getElementById('prizeQ2').textContent = `$${prizeQ2.toFixed(0)}`;
    document.getElementById('prizeQ3').textContent = `$${prizeQ3.toFixed(0)}`;
    document.getElementById('prizeQ4').textContent = `$${prizeQ4.toFixed(0)}`;
    document.getElementById('charityAmount').textContent = `$${charityAmount.toFixed(0)}`;

    // Update admin fundraiser stats module
    const squaresSoldAdmin = document.getElementById('squaresSoldAdmin');
    if (squaresSoldAdmin) squaresSoldAdmin.textContent = `${claimedSquares} / 100`;
    const totalCollectedAdmin = document.getElementById('totalCollectedAdmin');
    if (totalCollectedAdmin) totalCollectedAdmin.textContent = `$${totalCollected.toFixed(2)}`;
    const charityAmountAdmin = document.getElementById('charityAmountAdmin');
    if (charityAmountAdmin) charityAmountAdmin.textContent = `$${charityAmount.toFixed(2)}`;

    // Update admin prize percentage inputs
    const q1Input = document.getElementById('prizeQ1Pct');
    const q2Input = document.getElementById('prizeQ2Pct');
    const q3Input = document.getElementById('prizeQ3Pct');
    const q4Input = document.getElementById('prizeQ4Pct');
    const charityDisplay = document.getElementById('charityPct');

    if (q1Input) q1Input.value = prizeQ1Pct;
    if (q2Input) q2Input.value = prizeQ2Pct;
    if (q3Input) q3Input.value = prizeQ3Pct;
    if (q4Input) q4Input.value = prizeQ4Pct;
    if (charityDisplay) charityDisplay.textContent = Math.max(0, charityPct).toFixed(0);
}

async function savePrice() {
    const input = document.getElementById('pricePerSquare');
    const price = parseFloat(input.value) || 0;

    try {
        const response = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ price_per_square: price })
        });
        const result = await response.json();
        if (result.error) {
            alert(result.error);
        } else {
            gameData.config.price_per_square = price;
            updateStats();
        }
    } catch (error) {
        console.error('Error saving price:', error);
    }
}

async function savePrizePercentages() {
    const prize_q1 = parseFloat(document.getElementById('prizeQ1Pct').value) || 0;
    const prize_q2 = parseFloat(document.getElementById('prizeQ2Pct').value) || 0;
    const prize_q3 = parseFloat(document.getElementById('prizeQ3Pct').value) || 0;
    const prize_q4 = parseFloat(document.getElementById('prizeQ4Pct').value) || 0;

    const total = prize_q1 + prize_q2 + prize_q3 + prize_q4;
    if (total > 100) {
        alert('Total prize percentages cannot exceed 100%');
        return;
    }

    // Update charity display immediately
    document.getElementById('charityPct').textContent = (100 - total).toFixed(0);

    try {
        const response = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prize_q1, prize_q2, prize_q3, prize_q4 })
        });
        const result = await response.json();
        if (result.error) {
            alert(result.error);
        } else {
            gameData.config.prize_q1 = prize_q1;
            gameData.config.prize_q2 = prize_q2;
            gameData.config.prize_q3 = prize_q3;
            gameData.config.prize_q4 = prize_q4;
            updateStats();
        }
    } catch (error) {
        console.error('Error saving prize percentages:', error);
    }
}

async function saveSquaresLimit() {
    const input = document.getElementById('squaresLimitInput');
    const limit = parseInt(input.value) || 5;

    if (limit < 1 || limit > 100) {
        alert('Limit must be between 1 and 100');
        return;
    }

    try {
        const response = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ squares_limit: limit })
        });
        const result = await response.json();
        if (result.error) {
            alert(result.error);
        } else {
            squaresLimit = limit;
            document.getElementById('squaresLimit').textContent = limit;
        }
    } catch (error) {
        console.error('Error saving squares limit:', error);
    }
}

async function saveTeamName(team) {
    const input = document.getElementById(`team${team}`);
    const name = input.value.trim();

    try {
        const response = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [`team${team}_name`]: name })
        });
        const result = await response.json();
        if (result.error) {
            alert(result.error);
        } else {
            document.getElementById(`team${team}Label`).textContent = name || `Team ${team}`;
        }
    } catch (error) {
        console.error('Error saving team name:', error);
    }
}

async function randomizeNumbers() {
    if (!confirm('This will assign random numbers 0-9 to each row and column for this grid. Continue?')) {
        return;
    }

    try {
        const response = await fetch('/api/randomize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ grid_id: currentGridId })
        });
        const result = await response.json();

        if (result.error) {
            alert(result.error);
        } else {
            gameData.config.row_numbers = result.row_numbers;
            gameData.config.col_numbers = result.col_numbers;
            renderNumbers();
            highlightWinners();
        }
    } catch (error) {
        console.error('Error randomizing numbers:', error);
    }
}

async function clearNumbers() {
    if (!confirm('This will clear all numbers from the grid. Claimed squares will not be affected. Continue?')) {
        return;
    }

    try {
        const response = await fetch('/api/clear-numbers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ grid_id: currentGridId })
        });
        const result = await response.json();

        if (result.error) {
            alert(result.error);
        } else {
            gameData.config.row_numbers = null;
            gameData.config.col_numbers = null;
            renderNumbers();
            highlightWinners();
        }
    } catch (error) {
        console.error('Error clearing numbers:', error);
    }
}

async function lockNumbers() {
    if (!confirm('Once locked, numbers cannot be changed for this grid. Are you sure?')) {
        return;
    }

    try {
        const response = await fetch('/api/lock-numbers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ grid_id: currentGridId })
        });
        const result = await response.json();
        if (result.error) {
            alert(result.error);
        } else {
            gameData.config.numbers_locked = true;
            renderNumbers();
            await loadGrids();
        }
    } catch (error) {
        console.error('Error locking numbers:', error);
    }
}

async function saveScores() {
    const scores = {};
    ['q1_team1', 'q1_team2', 'q2_team1', 'q2_team2',
     'q3_team1', 'q3_team2', 'q4_team1', 'q4_team2'].forEach(field => {
        const input = document.getElementById(field);
        if (input) scores[field] = input.value;
    });

    try {
        const response = await fetch('/api/scores', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(scores)
        });

        const result = await response.json();
        if (result.error) {
            alert(result.error);
        } else {
            Object.assign(gameData.config, scores);
            highlightWinners();
        }
    } catch (error) {
        console.error('Error saving scores:', error);
    }
}

function highlightWinners() {
    document.querySelectorAll('.square.winner').forEach(el => {
        el.classList.remove('winner');
        const badge = el.querySelector('.win-count');
        if (badge) badge.remove();
    });

    const config = gameData.config;
    const rowNums = config.row_numbers;
    const colNums = config.col_numbers;

    if (!rowNums || !colNums) return;

    const winnersList = document.getElementById('winnersList');
    winnersList.innerHTML = '';

    const quarters = [
        { label: 'Q1', team1: config.q1_team1, team2: config.q1_team2 },
        { label: 'Q2', team1: config.q2_team1, team2: config.q2_team2 },
        { label: 'Q3', team1: config.q3_team1, team2: config.q3_team2 },
        { label: 'Q4/Final', team1: config.q4_team1, team2: config.q4_team2 }
    ];

    // First pass: count wins per square and collect winner card data
    const winCounts = new Map();
    const winnerCards = [];

    quarters.forEach(quarter => {
        if (quarter.team1 === null || quarter.team1 === undefined ||
            quarter.team2 === null || quarter.team2 === undefined ||
            quarter.team1 === '' || quarter.team2 === '') {
            return;
        }

        const team1LastDigit = parseInt(quarter.team1) % 10;
        const team2LastDigit = parseInt(quarter.team2) % 10;

        const col = colNums.indexOf(team1LastDigit);
        const row = rowNums.indexOf(team2LastDigit);

        if (col !== -1 && row !== -1) {
            const index = row * 10 + col;
            winCounts.set(index, (winCounts.get(index) || 0) + 1);

            const square = gameData.squares.find(s => s.row === row && s.col === col);
            winnerCards.push({
                index,
                label: quarter.label,
                winnerName: square?.owner_name || 'Unclaimed',
                score: `${config.team1_name || 'Team 1'}: ${quarter.team1} - ${config.team2_name || 'Team 2'}: ${quarter.team2}`
            });
        }
    });

    // Second pass: highlight squares and add multi-win badges
    const squares = document.querySelectorAll('.square');
    winCounts.forEach((count, index) => {
        if (squares[index]) {
            squares[index].classList.add('winner');
            if (count > 1) {
                const badge = document.createElement('span');
                badge.className = 'win-count';
                badge.textContent = `${count}x`;
                squares[index].appendChild(badge);
            }
        }
    });

    // Render winner cards
    winnerCards.forEach(wc => {
        const card = document.createElement('div');
        card.className = 'winner-card';
        card.innerHTML = `
            <div class="quarter-label">${wc.label}</div>
            <div class="winner-name">${wc.winnerName}</div>
            <div class="score">${wc.score}</div>
        `;
        winnersList.appendChild(card);
    });
}

async function resetGame() {
    if (!confirm('This will clear ALL squares and reset the game. This cannot be undone. Are you sure?')) {
        return;
    }

    try {
        const response = await fetch('/api/reset', { method: 'POST' });
        const result = await response.json();
        if (result.error) {
            alert(result.error);
        } else {
            location.reload();
        }
    } catch (error) {
        console.error('Error resetting game:', error);
    }
}

// Close modals on escape
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeModal();
        closeAdminModal();
    }
});

// Allow Enter to proceed in claim modal
document.getElementById('claimEmail')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        showConfirmation();
    }
});

// ==========================================
// Participant Management Functions
// ==========================================

async function loadParticipants() {
    if (!isAdmin) return;

    const container = document.getElementById('participantsList');
    if (!container) return;

    try {
        const response = await fetch('/api/admin/participants');
        const data = await response.json();

        if (data.error) {
            container.innerHTML = `<p class="error-text">${data.error}</p>`;
            return;
        }

        allParticipants = data.participants || [];
        const pricePerSquare = data.price_per_square || 10;

        // Update stats
        const unpaidParticipants = allParticipants.filter(p => !p.all_paid);
        const totalOwed = allParticipants.reduce((sum, p) => sum + p.amount_owed, 0);

        document.getElementById('participantsCount').textContent = `${allParticipants.length} participant${allParticipants.length !== 1 ? 's' : ''}`;
        document.getElementById('unpaidCount').textContent = `${unpaidParticipants.length} unpaid`;
        document.getElementById('totalOwed').textContent = `$${totalOwed.toFixed(2)} outstanding`;

        renderParticipants(pricePerSquare);

    } catch (error) {
        console.error('Error loading participants:', error);
        container.innerHTML = '<p class="error-text">Error loading participants</p>';
    }
}

function renderParticipants(pricePerSquare = 10) {
    const container = document.getElementById('participantsList');
    if (!container) return;

    if (allParticipants.length === 0) {
        container.innerHTML = '<p class="empty-text">No participants yet</p>';
        updateBulkActionsBar();
        return;
    }

    // Filter participants based on current filter
    let filteredParticipants = allParticipants;
    if (participantsFilter === 'paid') {
        filteredParticipants = allParticipants.filter(p => p.all_paid);
    } else if (participantsFilter === 'unpaid') {
        filteredParticipants = allParticipants.filter(p => !p.all_paid);
    }

    // Apply search filter
    if (participantsSearch) {
        const searchLower = participantsSearch.toLowerCase();
        filteredParticipants = filteredParticipants.filter(p =>
            p.name.toLowerCase().includes(searchLower) ||
            p.email.toLowerCase().includes(searchLower)
        );
    }

    // Apply sorting
    filteredParticipants = [...filteredParticipants].sort((a, b) => {
        if (participantsSort === 'name') {
            // Sort by last name (assume last word in name is last name)
            const aLastName = a.name.trim().split(/\s+/).pop().toLowerCase();
            const bLastName = b.name.trim().split(/\s+/).pop().toLowerCase();
            return aLastName.localeCompare(bLastName);
        } else if (participantsSort === 'claimed') {
            // Sort by claimed date (newest first)
            const aDate = a.first_claimed_at ? new Date(a.first_claimed_at) : new Date(0);
            const bDate = b.first_claimed_at ? new Date(b.first_claimed_at) : new Date(0);
            return bDate - aDate;
        }
        return 0;
    });

    if (filteredParticipants.length === 0) {
        container.innerHTML = `<p class="empty-text">No matching participants</p>`;
        updateBulkActionsBar();
        return;
    }

    // Render participants with checkboxes
    container.innerHTML = filteredParticipants.map(p => {
        let claimedDateStr = '';
        if (p.first_claimed_at) {
            try {
                const dt = new Date(p.first_claimed_at);
                claimedDateStr = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            } catch (e) {
                claimedDateStr = p.first_claimed_at;
            }
        }
        const isSelected = selectedParticipants.has(p.email);
        return `
        <div class="participant-row ${p.all_paid ? 'paid' : 'unpaid'} ${isSelected ? 'selected' : ''}">
            <div class="participant-checkbox">
                <input type="checkbox" ${isSelected ? 'checked' : ''} onchange="toggleParticipantSelection('${escapeHtml(p.email)}')" />
            </div>
            <div class="participant-info">
                <span class="participant-name">${escapeHtml(p.name)}</span>
                <span class="participant-email">${escapeHtml(p.email)}</span>
                <span class="participant-player-row">
                    ${p.player_name ? `<span class="participant-player">Supporting: ${escapeHtml(p.player_name)}</span>` : '<span class="participant-player no-player">No player specified</span>'}
                    <button class="edit-player-btn" onclick="showEditPlayerModal('${escapeHtml(p.email)}', '${escapeHtml(p.player_name || '')}')" title="Edit player"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></button>
                </span>
                ${claimedDateStr ? `<span class="participant-claimed">Claimed: ${claimedDateStr}</span>` : ''}
            </div>
            <div class="participant-squares">
                ${p.total_squares} square${p.total_squares !== 1 ? 's' : ''}
                <span class="amount">($${(p.total_squares * pricePerSquare).toFixed(2)})</span>
            </div>
            <div class="participant-status">
                ${p.all_paid
                    ? '<span class="status-badge paid">Paid</span>'
                    : `<span class="status-badge unpaid">Owes $${p.amount_owed.toFixed(2)}</span>`
                }
            </div>
            <div class="participant-actions">
                <button onclick="togglePaid('${escapeHtml(p.email)}', ${!p.all_paid})" class="${p.all_paid ? 'mark-unpaid-btn' : 'mark-paid-btn'}">
                    ${p.all_paid ? 'Mark Unpaid' : 'Mark Paid'}
                </button>
            </div>
        </div>
    `}).join('');

    updateSelectAllCheckbox();
    updateBulkActionsBar();
}

function filterParticipants(filter) {
    participantsFilter = filter;

    // Update active button
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    event.target.classList.add('active');

    // Re-render with new filter
    renderParticipants();
}

function sortParticipants(sortBy) {
    participantsSort = sortBy;

    // Update active button
    document.querySelectorAll('.sort-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    event.target.classList.add('active');

    // Re-render with new sort
    renderParticipants();
}

function searchParticipants(query) {
    participantsSearch = query.trim();
    renderParticipants();
}

async function togglePaid(email, markAsPaid) {
    try {
        const response = await fetch('/api/admin/participants/toggle-paid', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email, paid: markAsPaid })
        });

        const result = await response.json();
        if (result.error) {
            alert(result.error);
        } else {
            await loadParticipants();
        }
    } catch (error) {
        console.error('Error toggling paid status:', error);
        alert('Error updating payment status');
    }
}

function exportUnpaid() {
    window.location.href = '/api/admin/participants/export-unpaid';
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Logo preview function
function previewLogo(team) {
    const input = document.getElementById(`team${team}Logo`);
    const preview = document.getElementById(`team${team}LogoPreview`);

    if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = function(e) {
            preview.src = e.target.result;
            preview.style.display = 'block';
        };
        reader.readAsDataURL(input.files[0]);
    }
}

// Logo upload function
async function uploadLogo(team) {
    const input = document.getElementById(`team${team}Logo`);
    if (!input.files || !input.files[0]) {
        alert('Please select a file first');
        return;
    }

    const formData = new FormData();
    formData.append('team', team);
    formData.append('logo', input.files[0]);

    try {
        const response = await fetch('/api/admin/upload-logo', {
            method: 'POST',
            body: formData
        });

        const result = await response.json();
        if (result.error) {
            alert(result.error);
        } else {
            alert('Logo uploaded successfully!');
            // Update the grid display
            loadLogos();
        }
    } catch (error) {
        console.error('Error uploading logo:', error);
        alert('Error uploading logo');
    }
}

// Load and display team logos and colors
async function loadLogos() {
    try {
        const response = await fetch('/api/logos');
        const data = await response.json();

        // Update grid labels with logos
        const team1Label = document.getElementById('team1Label');
        const team2Label = document.getElementById('team2Label');
        const team1Name = window.team1Name || team1Label.textContent || 'Team 1';
        const team2Name = window.team2Name || team2Label.textContent || 'Team 2';

        if (data.team1_logo) {
            team1Label.innerHTML = `<img src="${data.team1_logo}" class="team-logo" alt=""><span>${team1Name}</span>`;
            // Update admin preview
            const preview1 = document.getElementById('team1LogoPreview');
            if (preview1) {
                preview1.src = data.team1_logo;
                preview1.style.display = 'block';
            }
        }

        if (data.team2_logo) {
            team2Label.innerHTML = `<img src="${data.team2_logo}" class="team-logo" alt=""><span>${team2Name}</span>`;
            // Update admin preview
            const preview2 = document.getElementById('team2LogoPreview');
            if (preview2) {
                preview2.src = data.team2_logo;
                preview2.style.display = 'block';
            }
        }

        // Apply team colors
        applyTeamColors(data.team1_color || '#0060aa', data.team2_color || '#cc0000');

        // Update color pickers in admin
        const color1Input = document.getElementById('team1Color');
        const color2Input = document.getElementById('team2Color');
        const color1Label = document.getElementById('team1ColorLabel');
        const color2Label = document.getElementById('team2ColorLabel');

        if (color1Input) color1Input.value = data.team1_color || '#0060aa';
        if (color2Input) color2Input.value = data.team2_color || '#cc0000';
        if (color1Label) color1Label.textContent = data.team1_color || '#0060aa';
        if (color2Label) color2Label.textContent = data.team2_color || '#cc0000';

    } catch (error) {
        console.error('Error loading logos:', error);
    }
}

// Apply team colors to the grid
function applyTeamColors(team1Color, team2Color) {
    const colNumbers = document.getElementById('colNumbers');
    const rowNumbers = document.getElementById('rowNumbers');
    const team1Label = document.getElementById('team1Label');
    const team2Label = document.getElementById('team2Label');

    if (colNumbers) colNumbers.style.backgroundColor = team1Color;
    if (rowNumbers) rowNumbers.style.backgroundColor = team2Color;
    if (team1Label) team1Label.style.backgroundColor = team1Color;
    if (team2Label) team2Label.style.backgroundColor = team2Color;
}

// Save team color
async function saveTeamColor(team) {
    const colorInput = document.getElementById(`team${team}Color`);
    const colorLabel = document.getElementById(`team${team}ColorLabel`);
    const color = colorInput.value;

    if (colorLabel) colorLabel.textContent = color;

    try {
        const response = await fetch('/api/admin/team-color', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ team: String(team), color: color })
        });

        const result = await response.json();
        if (result.error) {
            alert(result.error);
        } else {
            // Reload to apply colors
            loadLogos();
        }
    } catch (error) {
        console.error('Error saving team color:', error);
    }
}

// ==========================================
// Countdown Banner Functions
// ==========================================

const GAME_TIME = new Date('2026-02-08T18:30:00-05:00'); // Feb 8, 2026, 6:30 PM ET
let countdownInterval = null;

function initCountdown() {
    // Don't show if user closed it this session
    if (sessionStorage.getItem('countdownBannerClosed')) {
        return;
    }

    // Don't show for admin
    if (isAdmin) {
        return;
    }

    const banner = document.getElementById('countdownBanner');
    if (!banner) return;

    const config = gameData && gameData.config ? gameData.config : {};

    // If custom banner text is enabled, show that instead of countdown
    if (config.banner_enabled && config.banner_text) {
        const textDisplay = document.getElementById('bannerTextDisplay');
        if (textDisplay) {
            textDisplay.innerHTML = config.banner_text;
        }
        banner.classList.add('active');
        return;
    }

    // Otherwise show countdown if game hasn't started
    const now = new Date();
    if (now >= GAME_TIME) {
        return;
    }

    banner.classList.add('active');
    updateCountdown();
    countdownInterval = setInterval(updateCountdown, 1000);
}

function updateCountdown() {
    const now = new Date();
    const diff = GAME_TIME - now;

    // Game has started, hide banner
    if (diff <= 0) {
        closeCountdownBanner();
        return;
    }

    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);

    const countdownEl = document.getElementById('countdownInline');
    if (countdownEl) {
        countdownEl.textContent = `${days}d ${hours}h ${minutes}m ${seconds}s`;
    }
}

function closeCountdownBanner() {
    const banner = document.getElementById('countdownBanner');
    if (banner) {
        banner.classList.remove('active');
    }
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }
    sessionStorage.setItem('countdownBannerClosed', 'true');
}

// Initialize countdown after page loads (with slight delay to let admin status load)
setTimeout(initCountdown, 500);

// ==========================================
// Print Functions
// ==========================================

function printGrid() {
    window.print();
}

// ==========================================
// Mobile Menu Functions
// ==========================================

function toggleMobileMenu() {
    const btn = document.getElementById('hamburgerBtn');
    const menu = document.getElementById('mobileMenu');
    btn.classList.toggle('active');
    menu.classList.toggle('active');
}

function closeMobileMenu() {
    const btn = document.getElementById('hamburgerBtn');
    const menu = document.getElementById('mobileMenu');
    btn.classList.remove('active');
    menu.classList.remove('active');
}

// Close mobile menu when clicking outside
document.addEventListener('click', (e) => {
    const menu = document.getElementById('mobileMenu');
    const btn = document.getElementById('hamburgerBtn');
    if (menu && btn && !menu.contains(e.target) && !btn.contains(e.target)) {
        closeMobileMenu();
    }
});

// ==========================================
// Find Your Squares Functions
// ==========================================

let highlightedEmail = null;

function toggleFindSquares() {
    const banner = document.getElementById('findSquaresBanner');
    banner.classList.toggle('open');

    if (banner.classList.contains('open')) {
        const emailInput = document.getElementById('findSquaresEmail');
        emailInput.focus();
    }
}

function handleFindSquaresKeypress(event) {
    if (event.key === 'Enter') {
        findMySquares();
    }
}

async function findMySquares() {
    const emailInput = document.getElementById('findSquaresEmail');
    const email = emailInput.value.trim().toLowerCase();

    if (!email || !email.includes('@') || !email.includes('.')) {
        alert('Please enter a valid email address');
        return;
    }

    try {
        const response = await fetch(`/api/my-squares?email=${encodeURIComponent(email)}&grid_id=${currentGridId}`);
        const data = await response.json();

        if (data.error) {
            alert(data.error);
            return;
        }

        // Clear any existing highlights
        document.querySelectorAll('.square.my-square').forEach(el => {
            el.classList.remove('my-square');
        });

        const resultDiv = document.getElementById('findSquaresResult');
        const resultText = document.getElementById('findSquaresResultText');

        if (data.squares.length === 0) {
            resultDiv.style.display = 'flex';
            resultDiv.classList.add('no-squares');
            resultText.innerHTML = `No squares found for <strong>${escapeHtml(email)}</strong> on this grid`;
            highlightedEmail = null;
            localStorage.removeItem('findSquaresEmail');
        } else {
            // Highlight the squares
            data.squares.forEach(sq => {
                const squareEl = document.querySelector(`.square[data-row="${sq.row}"][data-col="${sq.col}"]`);
                if (squareEl) {
                    squareEl.classList.add('my-square');
                }
            });

            resultDiv.style.display = 'flex';
            resultDiv.classList.remove('no-squares');

            let message = `Highlighting <span class="highlight-count">${data.count}</span> square${data.count !== 1 ? 's' : ''}`;
            if (data.total_across_grids > data.count) {
                message += ` (${data.total_across_grids} total across all grids)`;
            }
            resultText.innerHTML = message;

            highlightedEmail = email;
            localStorage.setItem('findSquaresEmail', email);

            // Scroll to first highlighted square on mobile
            if (window.innerWidth <= 480) {
                const firstHighlighted = document.querySelector('.square.my-square');
                if (firstHighlighted) {
                    setTimeout(() => {
                        firstHighlighted.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }, 100);
                }
            }
        }
    } catch (error) {
        console.error('Error finding squares:', error);
        alert('Error finding squares. Please try again.');
    }
}

function clearHighlightedSquares() {
    document.querySelectorAll('.square.my-square').forEach(el => {
        el.classList.remove('my-square');
    });

    document.getElementById('findSquaresResult').style.display = 'none';
    document.getElementById('findSquaresEmail').value = '';
    highlightedEmail = null;
    localStorage.removeItem('findSquaresEmail');
}

// Restore highlighted squares after grid reload
function restoreHighlightedSquares() {
    const savedEmail = localStorage.getItem('findSquaresEmail');
    if (savedEmail && !isAdmin) {
        const emailInput = document.getElementById('findSquaresEmail');
        if (emailInput) {
            emailInput.value = savedEmail;
            // Auto-find squares after a short delay to ensure grid is loaded
            setTimeout(() => {
                findMySquares();
                // Open the banner to show results
                const banner = document.getElementById('findSquaresBanner');
                if (banner) banner.classList.add('open');
            }, 100);
        }
    }
}

// ==========================================
// Claim Deadline Functions
// ==========================================

function updateDeadlineBanner() {
    const banner = document.getElementById('claimDeadlineBanner');
    if (!banner) return;

    // Don't show for admin
    if (isAdmin) {
        banner.style.display = 'none';
        return;
    }

    if (!claimDeadline) {
        banner.style.display = 'none';
        return;
    }

    const now = new Date();
    const diff = claimDeadline - now;

    if (diff <= 0) {
        // Deadline passed
        banner.classList.add('closed');
        banner.innerHTML = '<span class="deadline-icon">⚠️</span><span class="deadline-text"><strong>Claims closed.</strong> The deadline has passed.</span>';
        banner.style.display = 'flex';
    } else {
        // Show countdown
        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

        let timeStr = '';
        if (days > 0) timeStr += `${days}d `;
        if (hours > 0 || days > 0) timeStr += `${hours}h `;
        timeStr += `${minutes}m`;

        banner.classList.remove('closed');
        banner.innerHTML = `<span class="deadline-icon">⏰</span><span class="deadline-text"><strong>${timeStr}</strong> remaining to claim squares</span>`;
        banner.style.display = 'flex';
    }
}

// Update deadline banner every minute
setInterval(updateDeadlineBanner, 60000);

async function saveClaimDeadline() {
    const input = document.getElementById('claimDeadlineInput');
    const deadline = input.value;

    try {
        const response = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ claim_deadline: deadline || null })
        });
        const result = await response.json();
        if (result.error) {
            alert(result.error);
        } else {
            claimDeadline = deadline ? new Date(deadline) : null;
            updateDeadlineBanner();
        }
    } catch (error) {
        console.error('Error saving deadline:', error);
    }
}

function clearClaimDeadline() {
    document.getElementById('claimDeadlineInput').value = '';
    saveClaimDeadline();
}

// ==========================================
// Bulk Mark Paid Functions
// ==========================================

function toggleParticipantSelection(email) {
    if (selectedParticipants.has(email)) {
        selectedParticipants.delete(email);
    } else {
        selectedParticipants.add(email);
    }
    updateBulkActionsBar();
    updateSelectAllCheckbox();
}

function toggleSelectAll() {
    const checkbox = document.getElementById('selectAllParticipants');
    const visibleEmails = getVisibleParticipantEmails();

    if (checkbox.checked) {
        visibleEmails.forEach(email => selectedParticipants.add(email));
    } else {
        visibleEmails.forEach(email => selectedParticipants.delete(email));
    }
    renderParticipants();
    updateBulkActionsBar();
}

function getVisibleParticipantEmails() {
    let filtered = allParticipants;
    if (participantsFilter === 'paid') {
        filtered = allParticipants.filter(p => p.all_paid);
    } else if (participantsFilter === 'unpaid') {
        filtered = allParticipants.filter(p => !p.all_paid);
    }
    if (participantsSearch) {
        const searchLower = participantsSearch.toLowerCase();
        filtered = filtered.filter(p =>
            p.name.toLowerCase().includes(searchLower) ||
            p.email.toLowerCase().includes(searchLower)
        );
    }
    return filtered.map(p => p.email);
}

function updateSelectAllCheckbox() {
    const checkbox = document.getElementById('selectAllParticipants');
    if (!checkbox) return;

    const visibleEmails = getVisibleParticipantEmails();
    const allSelected = visibleEmails.length > 0 && visibleEmails.every(email => selectedParticipants.has(email));
    const someSelected = visibleEmails.some(email => selectedParticipants.has(email));

    checkbox.checked = allSelected;
    checkbox.indeterminate = someSelected && !allSelected;
}

function updateBulkActionsBar() {
    const bar = document.getElementById('bulkActionsBar');
    const countEl = document.getElementById('bulkSelectedCount');

    if (!bar) return;

    if (selectedParticipants.size > 0) {
        bar.style.display = 'flex';
        countEl.textContent = `${selectedParticipants.size} selected`;
    } else {
        bar.style.display = 'none';
    }
}

async function bulkMarkPaid(paid) {
    if (selectedParticipants.size === 0) return;

    const action = paid ? 'mark as paid' : 'mark as unpaid';
    if (!confirm(`Are you sure you want to ${action} for ${selectedParticipants.size} participant(s)?`)) {
        return;
    }

    try {
        const response = await fetch('/api/admin/participants/bulk-mark-paid', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                emails: Array.from(selectedParticipants),
                paid: paid
            })
        });

        const result = await response.json();
        if (result.error) {
            alert(result.error);
        } else {
            selectedParticipants.clear();
            updateBulkActionsBar();
            await loadParticipants();
        }
    } catch (error) {
        console.error('Error bulk marking paid:', error);
        alert('Error updating payment status');
    }
}

// ==========================================
// Audit Log Functions
// ==========================================

async function loadAuditLog() {
    const container = document.getElementById('auditLogList');
    if (!container) return;

    container.innerHTML = '<p class="loading-text">Loading audit log...</p>';

    try {
        let url = `/api/admin/audit-log?page=${auditLogPage}&per_page=25`;
        if (auditLogFilter) url += `&action=${encodeURIComponent(auditLogFilter)}`;
        if (auditLogSearch) url += `&email=${encodeURIComponent(auditLogSearch)}`;

        const response = await fetch(url);
        const data = await response.json();

        if (data.error) {
            container.innerHTML = `<p class="error-text">${data.error}</p>`;
            return;
        }

        if (data.logs.length === 0) {
            container.innerHTML = '<p class="empty-text">No audit log entries found</p>';
            updateAuditLogPagination(data);
            return;
        }

        container.innerHTML = data.logs.map(log => {
            const timestamp = new Date(log.timestamp);
            const timeStr = timestamp.toLocaleDateString('en-US', {
                month: 'short', day: 'numeric', year: 'numeric',
                hour: '2-digit', minute: '2-digit'
            });

            let targetInfo = '';
            if (log.target_email) targetInfo = `<span class="log-target">${escapeHtml(log.target_email)}</span>`;
            if (log.grid_id && log.row !== null && log.col !== null) {
                targetInfo += `<span class="log-location">Grid ${log.grid_id}, Row ${log.row}, Col ${log.col}</span>`;
            }

            return `
                <div class="audit-log-entry">
                    <div class="log-header">
                        <span class="log-action ${log.action}">${formatActionName(log.action)}</span>
                        <span class="log-time">${timeStr}</span>
                    </div>
                    <div class="log-details">${escapeHtml(log.details || '')}</div>
                    ${targetInfo ? `<div class="log-meta">${targetInfo}</div>` : ''}
                </div>
            `;
        }).join('');

        updateAuditLogPagination(data);
    } catch (error) {
        console.error('Error loading audit log:', error);
        container.innerHTML = '<p class="error-text">Error loading audit log</p>';
    }
}

function formatActionName(action) {
    const names = {
        'square_claimed': 'Square Claimed',
        'square_cleared': 'Square Cleared',
        'payment_marked_paid': 'Marked Paid',
        'payment_marked_unpaid': 'Marked Unpaid',
        'numbers_randomized': 'Numbers Randomized',
        'numbers_locked': 'Numbers Locked',
        'numbers_cleared': 'Numbers Cleared',
        'live_scores_synced': 'Live Scores Synced',
        'live_sync_toggled': 'Live Sync Toggled',
        'quarter_unlocked': 'Quarter Unlocked',
        'quarter_locked': 'Quarter Locked',
        'emails_sent': 'Emails Sent',
        'emails_resend': 'Emails Resend',
        'config_changed': 'Config Changed',
        'game_reset': 'Game Reset'
    };
    return names[action] || action;
}

function updateAuditLogPagination(data) {
    const paginationEl = document.getElementById('auditLogPagination');
    if (!paginationEl) return;

    if (data.total_pages <= 1) {
        paginationEl.innerHTML = '';
        return;
    }

    paginationEl.innerHTML = `
        <button onclick="changeAuditLogPage(${auditLogPage - 1})" ${auditLogPage <= 1 ? 'disabled' : ''}>Previous</button>
        <span>Page ${data.page} of ${data.total_pages}</span>
        <button onclick="changeAuditLogPage(${auditLogPage + 1})" ${auditLogPage >= data.total_pages ? 'disabled' : ''}>Next</button>
    `;
}

function changeAuditLogPage(page) {
    auditLogPage = page;
    loadAuditLog();
}

function filterAuditLog(action) {
    auditLogFilter = action;
    auditLogPage = 1;
    loadAuditLog();
}

function searchAuditLog(email) {
    auditLogSearch = email.trim();
    auditLogPage = 1;
    loadAuditLog();
}

// ==========================================
// Edit Player Name Functions
// ==========================================

function showEditPlayerModal(email, currentPlayer) {
    const modal = document.getElementById('editPlayerModal');
    document.getElementById('editPlayerEmail').value = email;
    document.getElementById('editPlayerName').value = currentPlayer || '';
    document.getElementById('editPlayerEmailDisplay').textContent = email;
    modal.classList.add('active');
    lockBodyScroll();
}

function closeEditPlayerModal() {
    document.getElementById('editPlayerModal').classList.remove('active');
    unlockBodyScroll();
}

async function savePlayerName() {
    const email = document.getElementById('editPlayerEmail').value;
    const playerName = document.getElementById('editPlayerName').value.trim();

    try {
        const response = await fetch('/api/admin/participants/update-player', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, player_name: playerName })
        });

        const result = await response.json();
        if (result.error) {
            alert(result.error);
        } else {
            closeEditPlayerModal();
            await loadParticipants();
            await loadPlayerTotals();
        }
    } catch (error) {
        console.error('Error saving player name:', error);
        alert('Error saving player name');
    }
}

// ==========================================
// Player Totals Functions
// ==========================================

async function loadPlayerTotals() {
    const container = document.getElementById('playerTotalsList');
    if (!container) return;

    try {
        const response = await fetch('/api/admin/player-totals');
        const data = await response.json();

        if (data.error) {
            container.innerHTML = `<p class="error-text">${data.error}</p>`;
            return;
        }

        if (data.totals.length === 0) {
            container.innerHTML = '<p class="empty-text">No squares claimed yet</p>';
            return;
        }

        container.innerHTML = data.totals.map((p, index) => `
            <div class="player-total-row ${p.player === 'Not specified' ? 'unspecified' : ''}">
                <span class="player-rank">${index + 1}</span>
                <span class="player-name">${escapeHtml(p.player)}</span>
                <span class="player-squares">${p.square_count} square${p.square_count !== 1 ? 's' : ''}</span>
                <span class="player-amount">$${p.total_amount.toFixed(0)}</span>
                <span class="player-paid ${p.paid_count === p.square_count ? 'all-paid' : ''}">${p.paid_count}/${p.square_count} paid</span>
            </div>
        `).join('');
    } catch (error) {
        console.error('Error loading player totals:', error);
        container.innerHTML = '<p class="error-text">Error loading player totals</p>';
    }
}

// ==========================================
// Live Scores Functions
// ==========================================

async function fetchLiveScores() {
    const statusIndicator = document.getElementById('liveStatusIndicator');
    const statusText = document.getElementById('liveStatusText');
    const errorDiv = document.getElementById('liveScoresError');
    const currentDiv = document.getElementById('liveScoresCurrent');
    const gameInfoDiv = document.getElementById('liveGameInfo');
    const fetchBtn = document.getElementById('fetchLiveBtn');

    if (fetchBtn) fetchBtn.disabled = true;
    if (statusText) statusText.textContent = 'Fetching...';
    if (statusIndicator) statusIndicator.className = 'live-status-indicator fetching';
    if (errorDiv) errorDiv.style.display = 'none';

    try {
        const response = await fetch('/api/live-scores');
        const data = await response.json();

        if (data.error && !data.cached_scores) {
            // Check if this is a "game not found" error (expected before game day)
            if (data.error_type === 'game_not_found') {
                if (statusText) statusText.textContent = 'Waiting';
                if (statusIndicator) statusIndicator.className = 'live-status-indicator scheduled';
                if (errorDiv) {
                    errorDiv.innerHTML = `<strong>Game not yet available on ESPN</strong><br>` +
                        `Live scores for ${data.team1_name || 'Team 1'} vs ${data.team2_name || 'Team 2'} ` +
                        `will appear on game day.<br><br>` +
                        `<em>You can still enter scores manually using the controls below.</em>`;
                    errorDiv.style.display = 'block';
                }
            } else {
                if (statusText) statusText.textContent = 'Error';
                if (statusIndicator) statusIndicator.className = 'live-status-indicator error';
                if (errorDiv) {
                    errorDiv.textContent = data.error;
                    if (data.available_games) {
                        errorDiv.innerHTML += '<br><br>Available games:<br>' +
                            data.available_games.map(g => `- ${g.name}: ${g.teams.join(' vs ')}`).join('<br>');
                    }
                    errorDiv.style.display = 'block';
                }
            }
            if (currentDiv) currentDiv.style.display = 'none';
            return null;
        }

        // Update locked quarters state
        if (data.locked_quarters) {
            lockedQuarters = {
                q1: data.locked_quarters.q1,
                q2: data.locked_quarters.q2,
                q3: data.locked_quarters.q3,
                q4: data.locked_quarters.q4
            };
            updateQuarterLockUI();
        }

        // Update live sync toggle
        liveSyncEnabled = data.live_sync_enabled || false;
        const liveSyncToggle = document.getElementById('liveSyncToggle');
        if (liveSyncToggle) liveSyncToggle.checked = liveSyncEnabled;

        if (data.game) {
            const game = data.game;

            // Update status
            if (game.is_final) {
                if (statusText) statusText.textContent = 'Final';
                if (statusIndicator) statusIndicator.className = 'live-status-indicator final';
            } else if (game.is_halftime) {
                if (statusText) statusText.textContent = 'Halftime';
                if (statusIndicator) statusIndicator.className = 'live-status-indicator halftime';
            } else if (game.period > 0) {
                if (statusText) statusText.textContent = 'Live';
                if (statusIndicator) statusIndicator.className = 'live-status-indicator live';
            } else {
                if (statusText) statusText.textContent = game.status || 'Scheduled';
                if (statusIndicator) statusIndicator.className = 'live-status-indicator scheduled';
            }

            // Update game info
            if (gameInfoDiv) {
                gameInfoDiv.style.display = 'flex';
                const periodEl = document.getElementById('gamePeriod');
                const clockEl = document.getElementById('gameClock');
                if (periodEl) {
                    if (game.is_final) {
                        periodEl.textContent = 'Final';
                    } else if (game.is_halftime) {
                        periodEl.textContent = 'Halftime';
                    } else if (game.period > 0) {
                        periodEl.textContent = `Q${game.period}`;
                    } else {
                        periodEl.textContent = '';
                    }
                }
                if (clockEl) clockEl.textContent = game.clock || '';
            }

            // Update current score display
            if (currentDiv) {
                currentDiv.style.display = 'flex';
                const team1NameEl = document.getElementById('liveTeam1Name');
                const team2NameEl = document.getElementById('liveTeam2Name');
                const team1ScoreEl = document.getElementById('liveTeam1Score');
                const team2ScoreEl = document.getElementById('liveTeam2Score');

                if (team1NameEl) team1NameEl.textContent = game.team1_name_espn || 'Team 1';
                if (team2NameEl) team2NameEl.textContent = game.team2_name_espn || 'Team 2';
                if (team1ScoreEl) team1ScoreEl.textContent = game.team1_score ?? '-';
                if (team2ScoreEl) team2ScoreEl.textContent = game.team2_score ?? '-';
            }

            return data;
        } else if (data.cached_scores) {
            // Show cached scores when ESPN is unavailable
            if (statusText) statusText.textContent = 'ESPN unavailable';
            if (statusIndicator) statusIndicator.className = 'live-status-indicator error';
            if (currentDiv) currentDiv.style.display = 'none';
            return null;
        }

        return data;

    } catch (error) {
        console.error('Error fetching live scores:', error);
        if (statusText) statusText.textContent = 'Connection error';
        if (statusIndicator) statusIndicator.className = 'live-status-indicator error';
        if (errorDiv) {
            errorDiv.textContent = 'Could not connect to server';
            errorDiv.style.display = 'block';
        }
        return null;
    } finally {
        if (fetchBtn) fetchBtn.disabled = false;
    }
}

async function syncLiveScores() {
    const syncBtn = document.getElementById('syncLiveBtn');
    if (syncBtn) {
        syncBtn.disabled = true;
        syncBtn.textContent = 'Syncing...';
    }

    try {
        const response = await fetch('/api/admin/sync-live-scores', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        const data = await response.json();

        if (data.error) {
            alert('Sync error: ' + data.error);
            return;
        }

        if (data.updated_quarters && data.updated_quarters.length > 0) {
            alert(`Synced scores for: ${data.updated_quarters.join(', ')}`);
            // Reload grid to show updated scores and winners
            await loadGrid();
        } else {
            alert('No quarters ready to sync yet. Scores are synced when quarters complete.');
        }

        // Refresh live scores display and email status
        await fetchLiveScores();
        setTimeout(loadEmailStatus, 2000);

    } catch (error) {
        console.error('Error syncing live scores:', error);
        alert('Error syncing scores. Please try again.');
    } finally {
        if (syncBtn) {
            syncBtn.disabled = false;
            syncBtn.textContent = 'Sync Now';
        }
    }
}

async function toggleLiveSync() {
    const toggle = document.getElementById('liveSyncToggle');
    const enabled = toggle ? toggle.checked : false;

    try {
        const response = await fetch('/api/admin/live-sync-toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled })
        });

        const data = await response.json();
        if (data.error) {
            alert('Error: ' + data.error);
            if (toggle) toggle.checked = !enabled;
            return;
        }

        liveSyncEnabled = enabled;

        // Start or stop auto-refresh based on toggle
        if (enabled) {
            startLiveScoresAutoRefresh();
        } else {
            stopLiveScoresAutoRefresh();
        }

    } catch (error) {
        console.error('Error toggling live sync:', error);
        alert('Error updating setting');
        if (toggle) toggle.checked = !enabled;
    }
}

async function checkAndSyncLiveScores() {
    if (!isAdmin || !liveSyncEnabled) return;
    const data = await fetchLiveScores();
    if (data && data.game && liveSyncEnabled) {
        const game = data.game;
        const shouldSync = (
            (game.period > 1 && !lockedQuarters.q1) ||
            ((game.period > 2 || game.is_halftime) && !lockedQuarters.q2) ||
            ((game.period > 3 || game.is_final) && !lockedQuarters.q3) ||
            (game.is_final && !lockedQuarters.q4)
        );
        if (shouldSync) {
            await syncLiveScores();
        }
    }
}

function startLiveScoresAutoRefresh() {
    // Refresh every 30 seconds when live sync is enabled
    if (liveScoresInterval) clearInterval(liveScoresInterval);
    liveScoresInterval = setInterval(async () => {
        if (!isAdmin || !liveSyncEnabled) {
            stopLiveScoresAutoRefresh();
            return;
        }
        await checkAndSyncLiveScores();
    }, 30000);

    // Also sync immediately when tab becomes visible again (browsers throttle
    // setInterval on background tabs, so the 30s poll may not fire)
    document.addEventListener('visibilitychange', handleVisibilitySync);
}

async function handleVisibilitySync() {
    if (document.visibilityState === 'visible' && isAdmin && liveSyncEnabled) {
        await checkAndSyncLiveScores();
    }
}

function stopLiveScoresAutoRefresh() {
    if (liveScoresInterval) {
        clearInterval(liveScoresInterval);
        liveScoresInterval = null;
    }
    document.removeEventListener('visibilitychange', handleVisibilitySync);
}

async function toggleQuarterLock(quarter) {
    const isLocked = lockedQuarters[`q${quarter}`];

    try {
        const endpoint = isLocked ? '/api/admin/unlock-quarter' : '/api/admin/lock-quarter';
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quarter })
        });

        const data = await response.json();
        if (data.error) {
            alert('Error: ' + data.error);
            return;
        }

        lockedQuarters[`q${quarter}`] = !isLocked;
        updateQuarterLockUI();

    } catch (error) {
        console.error('Error toggling quarter lock:', error);
        alert('Error updating quarter lock');
    }
}

function updateQuarterLockUI() {
    for (let q = 1; q <= 4; q++) {
        const isLocked = lockedQuarters[`q${q}`];
        const quarterDiv = document.getElementById(`quarterQ${q}`);
        const statusSpan = document.getElementById(`q${q}LockStatus`);
        const lockBtn = document.getElementById(`q${q}LockBtn`);
        const team1Input = document.getElementById(`q${q}_team1`);
        const team2Input = document.getElementById(`q${q}_team2`);

        if (quarterDiv) {
            quarterDiv.classList.toggle('locked', isLocked);
        }
        if (statusSpan) {
            statusSpan.textContent = isLocked ? '(locked)' : '';
            statusSpan.className = 'quarter-lock-status' + (isLocked ? ' locked' : '');
        }
        if (lockBtn) {
            lockBtn.textContent = isLocked ? 'Unlock' : 'Lock';
            lockBtn.className = 'quarter-lock-btn' + (isLocked ? ' locked' : '');
        }
        if (team1Input) {
            team1Input.disabled = isLocked;
        }
        if (team2Input) {
            team2Input.disabled = isLocked;
        }
    }
}

// Initialize live scores when admin panel loads
function initLiveScores() {
    if (!isAdmin) return;

    // Fetch initial live scores data
    fetchLiveScores();

    // Load email status
    loadEmailStatus();

    // Start auto-refresh if enabled
    if (liveSyncEnabled) {
        startLiveScoresAutoRefresh();
    }
}

// ==========================================
// Email Notification Functions
// ==========================================

// Alert Banner functions
async function toggleBanner() {
    const toggle = document.getElementById('bannerEnabledToggle');
    const enabled = toggle ? toggle.checked : false;

    try {
        const response = await fetch('/api/admin/banner', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled })
        });
        const data = await response.json();
        if (data.error) {
            alert('Error: ' + data.error);
            if (toggle) toggle.checked = !enabled;
        }
    } catch (err) {
        alert('Failed to update banner');
        if (toggle) toggle.checked = !enabled;
    }
}

async function saveBannerText() {
    const textarea = document.getElementById('bannerTextInput');
    const text = textarea ? textarea.value.trim() : '';

    try {
        const response = await fetch('/api/admin/banner', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text })
        });
        const data = await response.json();
        if (data.error) {
            alert('Error: ' + data.error);
        } else {
            alert('Banner text saved!');
        }
    } catch (err) {
        alert('Failed to save banner text');
    }
}

function loadAlertBanner(config) {
    // Load admin controls if present
    const toggle = document.getElementById('bannerEnabledToggle');
    const textarea = document.getElementById('bannerTextInput');
    if (toggle) toggle.checked = !!config.banner_enabled;
    if (textarea) textarea.value = config.banner_text || '';

    // Re-init the banner display for non-admin
    if (!isAdmin) {
        initCountdown();
    }
}

async function toggleEmails() {
    const toggle = document.getElementById('emailsEnabledToggle');
    const enabled = toggle ? toggle.checked : false;

    try {
        const response = await fetch('/api/admin/email-toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled })
        });

        const data = await response.json();
        if (data.error) {
            alert('Error: ' + data.error);
            if (toggle) toggle.checked = !enabled;
        }
    } catch (error) {
        console.error('Error toggling emails:', error);
        alert('Error updating email setting');
        if (toggle) toggle.checked = !enabled;
    }
}

async function loadEmailStatus() {
    if (!isAdmin) return;

    try {
        const response = await fetch('/api/admin/email-status');
        const data = await response.json();

        // Update toggle
        const toggle = document.getElementById('emailsEnabledToggle');
        if (toggle) toggle.checked = data.emails_enabled;

        // Update config hint
        const hint = document.getElementById('emailConfigHint');
        if (hint) {
            // We can't check env vars from frontend, but the backend will silently skip if not configured
            hint.textContent = '';
        }

        // Update per-quarter badges
        for (let q = 1; q <= 4; q++) {
            const counts = data.quarters[`q${q}`];
            const badge = document.getElementById(`emailQ${q}Badge`);
            const resendBtn = document.getElementById(`emailQ${q}Resend`);
            const statusDiv = document.getElementById(`emailQ${q}Status`);

            if (!badge) continue;

            const total = counts.sent + counts.failed + counts.pending;
            const isLocked = lockedQuarters[`q${q}`];

            if (total === 0) {
                badge.textContent = 'Not sent';
                badge.className = 'email-q-badge not-sent';
                // Show resend if quarter is locked (scores available)
                if (resendBtn) resendBtn.style.display = isLocked ? 'inline-block' : 'none';
            } else if (counts.failed > 0) {
                badge.textContent = `${counts.sent} sent, ${counts.failed} failed`;
                badge.className = 'email-q-badge has-failed';
                if (resendBtn) resendBtn.style.display = 'inline-block';
            } else if (counts.pending > 0) {
                badge.textContent = `${counts.pending} pending...`;
                badge.className = 'email-q-badge pending';
                if (resendBtn) resendBtn.style.display = 'none';
            } else {
                badge.textContent = `${counts.sent} sent`;
                badge.className = 'email-q-badge all-sent';
                if (resendBtn) resendBtn.style.display = 'none';
            }
        }
    } catch (error) {
        console.error('Error loading email status:', error);
    }
}

async function resendEmails(quarter) {
    if (!confirm(`Resend all emails for Q${quarter}? This will delete existing email records for this quarter and send all emails again.`)) {
        return;
    }

    try {
        const response = await fetch('/api/admin/resend-emails', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quarter })
        });

        const data = await response.json();
        if (data.error) {
            alert('Error: ' + data.error);
        } else {
            alert(`Re-sending emails for Q${quarter}. Check status in a moment.`);
            // Reload status after a short delay to let emails start sending
            setTimeout(loadEmailStatus, 3000);
        }
    } catch (error) {
        console.error('Error resending emails:', error);
        alert('Error resending emails');
    }
}
