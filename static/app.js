let gameData = { squares: [], config: {} };
let isAdmin = false;
let squaresLimit = 5;
let selectedSquare = null;
let selectedSquares = [];

// Initialize the app
document.addEventListener('DOMContentLoaded', async () => {
    await checkAdminStatus();
    await loadGrid();
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
        }
    } catch (error) {
        console.error('Error checking admin status:', error);
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

async function loadGrid() {
    try {
        const response = await fetch('/api/grid');
        const data = await response.json();
        gameData = data;
        squaresLimit = data.squares_limit || 5;

        document.getElementById('squaresLimit').textContent = squaresLimit;

        renderGrid();
        renderNumbers();
        loadConfig();
        updateStats();
        highlightWinners();
    } catch (error) {
        console.error('Error loading grid:', error);
    }
}

function renderGrid() {
    const grid = document.getElementById('grid');
    grid.innerHTML = '';

    for (let row = 0; row < 10; row++) {
        for (let col = 0; col < 10; col++) {
            const square = gameData.squares.find(s => s.row === row && s.col === col);
            const div = document.createElement('div');
            div.className = 'square';
            div.dataset.row = row;
            div.dataset.col = col;

            if (square && square.owner_name) {
                div.textContent = square.owner_name;
                div.classList.add('claimed');
            }

            div.addEventListener('click', () => handleSquareClick(row, col, square));
            grid.appendChild(div);
        }
    }
}

function handleSquareClick(row, col, square) {
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

    // Show/hide claim button
    const claimBtn = document.getElementById('claimSelectedBtn');
    if (claimBtn) {
        claimBtn.style.display = selectedSquares.length > 0 ? 'block' : 'none';
        claimBtn.textContent = `Claim ${selectedSquares.length} Square${selectedSquares.length !== 1 ? 's' : ''}`;
    }
}

function openClaimModalMulti() {
    if (selectedSquares.length === 0) return;

    const squaresList = selectedSquares.map(s => `Row ${s.row}, Col ${s.col}`).join('; ');
    document.getElementById('modalSquaresList').textContent = squaresList;
    document.getElementById('modalSquaresCount').textContent = selectedSquares.length;
    document.getElementById('claimName').value = localStorage.getItem('lastClaimName') || '';
    document.getElementById('claimEmail').value = localStorage.getItem('lastClaimEmail') || '';
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
    selectedSquare = null;
    selectedSquares = [];
    updateSelectedDisplay();
}

function showConfirmation() {
    const name = document.getElementById('claimName').value.trim();
    const email = document.getElementById('claimEmail').value.trim();

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

    // Show confirmation modal
    const squaresList = selectedSquares.map(s => `Row ${s.row}, Col ${s.col}`).join('; ');
    document.getElementById('confirmSquaresList').textContent = squaresList;
    document.getElementById('confirmSquaresCount').textContent = selectedSquares.length;
    document.getElementById('confirmName').textContent = name;
    document.getElementById('confirmEmail').textContent = email;

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

    let successCount = 0;
    let errors = [];

    for (const square of selectedSquares) {
        try {
            const response = await fetch('/api/claim', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    row: square.row,
                    col: square.col,
                    name: name,
                    email: email
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
        alert(`Successfully claimed ${successCount} square${successCount !== 1 ? 's' : ''}! Thank you for participating.`);
    }
    if (errors.length > 0) {
        alert(`Some squares could not be claimed:\n${errors.join('\n')}`);
    }

    loadGrid();
}

// Admin functions
function openAdminClearModal(row, col, ownerName) {
    selectedSquare = { row, col };
    document.getElementById('clearRow').textContent = row;
    document.getElementById('clearCol').textContent = col;
    document.getElementById('clearOwnerName').textContent = ownerName;
    document.getElementById('adminClearModal').classList.add('active');
}

function closeAdminModal() {
    document.getElementById('adminClearModal').classList.remove('active');
    selectedSquare = null;
}

async function adminClearSquare() {
    try {
        const response = await fetch('/api/admin/clear-square', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                row: selectedSquare.row,
                col: selectedSquare.col
            })
        });

        const result = await response.json();
        if (result.error) {
            alert(result.error);
        } else {
            closeAdminModal();
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
    const lockBtn = document.getElementById('lockBtn');

    if (randomizeBtn && lockBtn && gameData.config.numbers_locked) {
        randomizeBtn.disabled = true;
        lockBtn.disabled = true;
        lockBtn.textContent = 'Numbers Locked';
    }
}

function loadConfig() {
    const config = gameData.config;

    const team1Input = document.getElementById('team1');
    const team2Input = document.getElementById('team2');

    if (team1Input) team1Input.value = config.team1_name || '';
    if (team2Input) team2Input.value = config.team2_name || '';

    document.getElementById('team1Label').textContent = config.team1_name || 'Team 1';
    document.getElementById('team2Label').textContent = config.team2_name || 'Team 2';

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
}

function updateStats() {
    const claimedSquares = gameData.squares.filter(s => s.owner_name).length;
    const pricePerSquare = parseFloat(gameData.config.price_per_square) || 10;
    const totalCollected = claimedSquares * pricePerSquare;

    document.getElementById('squaresSold').textContent = `${claimedSquares} / 100`;
    document.getElementById('totalCollected').textContent = `$${totalCollected.toFixed(2)}`;
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
    if (!confirm('This will assign random numbers 0-9 to each row and column. Continue?')) {
        return;
    }

    try {
        const response = await fetch('/api/randomize', { method: 'POST' });
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

async function lockNumbers() {
    if (!confirm('Once locked, numbers cannot be changed. Are you sure?')) {
        return;
    }

    try {
        const response = await fetch('/api/lock-numbers', { method: 'POST' });
        const result = await response.json();
        if (result.error) {
            alert(result.error);
        } else {
            gameData.config.numbers_locked = true;
            renderNumbers();
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
    document.querySelectorAll('.square.winner').forEach(el => el.classList.remove('winner'));

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
            const squares = document.querySelectorAll('.square');
            const index = row * 10 + col;
            if (squares[index]) {
                squares[index].classList.add('winner');

                const square = gameData.squares.find(s => s.row === row && s.col === col);
                const winnerName = square?.owner_name || 'Unclaimed';

                const card = document.createElement('div');
                card.className = 'winner-card';
                card.innerHTML = `
                    <div class="quarter-label">${quarter.label}</div>
                    <div class="winner-name">${winnerName}</div>
                    <div class="score">${config.team1_name || 'Team 1'}: ${quarter.team1} - ${config.team2_name || 'Team 2'}: ${quarter.team2}</div>
                `;
                winnersList.appendChild(card);
            }
        }
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
