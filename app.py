from flask import Flask, render_template, request, jsonify, session, redirect
import sqlite3
import json
import random
import hashlib
import os
import urllib.request
import urllib.error
import smtplib
import threading
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from datetime import datetime
from functools import wraps

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', os.urandom(24))

# Use /data for persistent storage on Render, local file otherwise
if os.path.exists('/data'):
    DATABASE = '/data/squares.db'
else:
    DATABASE = 'squares.db'
SQUARES_PER_EMAIL_LIMIT = 5
GMAIL_ADDRESS = os.environ.get('GMAIL_ADDRESS', '')
GMAIL_APP_PASSWORD = os.environ.get('GMAIL_APP_PASSWORD', '')

def get_db():
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    return conn

def hash_password(password):
    return hashlib.sha256(password.encode()).hexdigest()

def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'is_admin' not in session or not session['is_admin']:
            return jsonify({'error': 'Admin access required'}), 403
        return f(*args, **kwargs)
    return decorated_function

def log_audit(action, details=None, actor_email=None, target_email=None, grid_id=None, row=None, col=None):
    """Log an action to the audit log"""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('''
        INSERT INTO audit_log (action, details, actor_email, target_email, grid_id, row, col, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ''', (action, details, actor_email, target_email, grid_id, row, col, datetime.now().isoformat()))
    conn.commit()
    conn.close()

def init_db():
    conn = get_db()
    cursor = conn.cursor()

    # Create audit_log table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT NOT NULL,
            details TEXT,
            actor_email TEXT,
            target_email TEXT,
            grid_id INTEGER,
            row INTEGER,
            col INTEGER,
            timestamp TEXT NOT NULL
        )
    ''')

    # Create grids table (each grid has its own numbers)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS grids (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            row_numbers TEXT,
            col_numbers TEXT,
            numbers_locked INTEGER DEFAULT 0,
            created_at TEXT,
            is_active INTEGER DEFAULT 1
        )
    ''')

    # Create squares table with grid_id
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS squares (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            grid_id INTEGER NOT NULL DEFAULT 1,
            row INTEGER NOT NULL,
            col INTEGER NOT NULL,
            owner_name TEXT,
            owner_email TEXT,
            claimed_at TEXT,
            UNIQUE(grid_id, row, col),
            FOREIGN KEY (grid_id) REFERENCES grids(id)
        )
    ''')

    # Create game_config table (shared across all grids)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS game_config (
            id INTEGER PRIMARY KEY,
            team1_name TEXT DEFAULT 'Team 1',
            team2_name TEXT DEFAULT 'Team 2',
            price_per_square REAL DEFAULT 10.00,
            squares_limit INTEGER DEFAULT 5,
            prize_q1 REAL DEFAULT 10.0,
            prize_q2 REAL DEFAULT 10.0,
            prize_q3 REAL DEFAULT 10.0,
            prize_q4 REAL DEFAULT 20.0,
            q1_team1 INTEGER,
            q1_team2 INTEGER,
            q2_team1 INTEGER,
            q2_team2 INTEGER,
            q3_team1 INTEGER,
            q3_team2 INTEGER,
            q4_team1 INTEGER,
            q4_team2 INTEGER
        )
    ''')

    # Create admin user table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS admins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL
        )
    ''')

    # Migration: Add grid_id column if not exists (for existing databases)
    try:
        cursor.execute('ALTER TABLE squares ADD COLUMN grid_id INTEGER NOT NULL DEFAULT 1')
    except sqlite3.OperationalError:
        pass

    # Migration: Add owner_email column if not exists
    try:
        cursor.execute('ALTER TABLE squares ADD COLUMN owner_email TEXT')
    except sqlite3.OperationalError:
        pass

    # Migration: Add prize percentage columns if not exists
    for col in ['prize_q1', 'prize_q2', 'prize_q3', 'prize_q4']:
        try:
            default = 20.0 if col == 'prize_q4' else 10.0
            cursor.execute(f'ALTER TABLE game_config ADD COLUMN {col} REAL DEFAULT {default}')
        except sqlite3.OperationalError:
            pass

    # Migration: Add squares_limit column if not exists
    try:
        cursor.execute('ALTER TABLE game_config ADD COLUMN squares_limit INTEGER DEFAULT 5')
    except sqlite3.OperationalError:
        pass

    # Migration: Add paid column to squares table if not exists
    try:
        cursor.execute('ALTER TABLE squares ADD COLUMN paid INTEGER DEFAULT 0')
    except sqlite3.OperationalError:
        pass

    # Migration: Add team logo columns to game_config if not exists
    try:
        cursor.execute('ALTER TABLE game_config ADD COLUMN team1_logo TEXT')
    except sqlite3.OperationalError:
        pass
    try:
        cursor.execute('ALTER TABLE game_config ADD COLUMN team2_logo TEXT')
    except sqlite3.OperationalError:
        pass

    # Migration: Add team color columns to game_config if not exists
    try:
        cursor.execute("ALTER TABLE game_config ADD COLUMN team1_color TEXT DEFAULT '#0060aa'")
    except sqlite3.OperationalError:
        pass
    try:
        cursor.execute("ALTER TABLE game_config ADD COLUMN team2_color TEXT DEFAULT '#cc0000'")
    except sqlite3.OperationalError:
        pass

    # Migration: Add show_winners column to game_config if not exists
    try:
        cursor.execute('ALTER TABLE game_config ADD COLUMN show_winners INTEGER DEFAULT 0')
    except sqlite3.OperationalError:
        pass

    # Migration: Add player_name column to squares table if not exists
    try:
        cursor.execute('ALTER TABLE squares ADD COLUMN player_name TEXT')
    except sqlite3.OperationalError:
        pass

    # Migration: Add claim_deadline column to game_config if not exists
    try:
        cursor.execute('ALTER TABLE game_config ADD COLUMN claim_deadline TEXT')
    except sqlite3.OperationalError:
        pass

    # Migration: Add live score tracking columns to game_config
    for col in ['q1_locked', 'q2_locked', 'q3_locked', 'q4_locked']:
        try:
            cursor.execute(f'ALTER TABLE game_config ADD COLUMN {col} INTEGER DEFAULT 0')
        except sqlite3.OperationalError:
            pass
    try:
        cursor.execute('ALTER TABLE game_config ADD COLUMN live_sync_enabled INTEGER DEFAULT 0')
    except sqlite3.OperationalError:
        pass
    try:
        cursor.execute('ALTER TABLE game_config ADD COLUMN espn_game_id TEXT')
    except sqlite3.OperationalError:
        pass

    # Create email_sends table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS email_sends (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            quarter INTEGER NOT NULL,
            grid_id INTEGER,
            email_type TEXT NOT NULL,
            recipient_email TEXT NOT NULL,
            recipient_name TEXT,
            status TEXT DEFAULT 'pending',
            error_message TEXT,
            created_at TEXT NOT NULL,
            sent_at TEXT
        )
    ''')

    # Migration: Add emails_enabled column to game_config
    try:
        cursor.execute('ALTER TABLE game_config ADD COLUMN emails_enabled INTEGER DEFAULT 0')
    except sqlite3.OperationalError:
        pass

    # Create default grid if none exists
    cursor.execute('SELECT COUNT(*) FROM grids')
    if cursor.fetchone()[0] == 0:
        # Check if we need to migrate from old game_config (has row_numbers column)
        try:
            cursor.execute('SELECT row_numbers, col_numbers, numbers_locked FROM game_config WHERE id = 1')
            old_config = cursor.fetchone()
            if old_config and old_config[0]:
                cursor.execute('''
                    INSERT INTO grids (name, row_numbers, col_numbers, numbers_locked, created_at)
                    VALUES (?, ?, ?, ?, ?)
                ''', ('Grid 1', old_config[0], old_config[1], old_config[2], datetime.now().isoformat()))
            else:
                cursor.execute('''
                    INSERT INTO grids (name, created_at) VALUES (?, ?)
                ''', ('Grid 1', datetime.now().isoformat()))
        except sqlite3.OperationalError:
            # Old columns don't exist, create fresh grid
            cursor.execute('''
                INSERT INTO grids (name, created_at) VALUES (?, ?)
            ''', ('Grid 1', datetime.now().isoformat()))

    # Initialize all 100 squares for grid 1 if not exist
    cursor.execute('SELECT COUNT(*) FROM squares WHERE grid_id = 1')
    if cursor.fetchone()[0] == 0:
        for row in range(10):
            for col in range(10):
                cursor.execute('''
                    INSERT OR IGNORE INTO squares (grid_id, row, col) VALUES (?, ?, ?)
                ''', (1, row, col))

    # Initialize game config if not exist
    cursor.execute('SELECT COUNT(*) FROM game_config')
    if cursor.fetchone()[0] == 0:
        cursor.execute('''
            INSERT INTO game_config (id, team1_name, team2_name)
            VALUES (1, 'Team 1', 'Team 2')
        ''')

    # Create default admin if none exists
    cursor.execute('SELECT COUNT(*) FROM admins')
    if cursor.fetchone()[0] == 0:
        cursor.execute('''
            INSERT INTO admins (email, password) VALUES (?, ?)
        ''', ('admin@example.com', hash_password('admin123')))

    conn.commit()
    conn.close()

def create_grid(name):
    """Create a new grid and initialize its 100 squares"""
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('''
        INSERT INTO grids (name, created_at) VALUES (?, ?)
    ''', (name, datetime.now().isoformat()))
    grid_id = cursor.lastrowid

    # Initialize 100 squares for this grid
    for row in range(10):
        for col in range(10):
            cursor.execute('''
                INSERT INTO squares (grid_id, row, col) VALUES (?, ?, ?)
            ''', (grid_id, row, col))

    conn.commit()
    conn.close()
    return grid_id

# Main page - no login required
@app.route('/')
def index():
    return render_template('index.html')

# Admin login page
@app.route('/admin')
def admin_page():
    if session.get('is_admin'):
        return redirect('/')
    return render_template('admin_login.html')

@app.route('/api/admin/login', methods=['POST'])
def admin_login():
    data = request.get_json()
    email = data.get('email', '').strip().lower()
    password = data.get('password', '')

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('SELECT password FROM admins WHERE email = ?', (email,))
    admin = cursor.fetchone()
    conn.close()

    if not admin or admin['password'] != hash_password(password):
        return jsonify({'error': 'Invalid credentials'}), 401

    session['is_admin'] = True
    return jsonify({'success': True})

@app.route('/api/admin/logout', methods=['POST'])
def admin_logout():
    session.pop('is_admin', None)
    return jsonify({'success': True})

@app.route('/api/admin/status', methods=['GET'])
def admin_status():
    return jsonify({'is_admin': session.get('is_admin', False)})

@app.route('/api/admin/audit-log', methods=['GET'])
@admin_required
def get_audit_log():
    """Get audit log with optional filtering and pagination"""
    action_filter = request.args.get('action', '')
    email_search = request.args.get('email', '')
    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', 50, type=int)

    conn = get_db()
    cursor = conn.cursor()

    # Build query with filters
    query = 'SELECT * FROM audit_log WHERE 1=1'
    params = []

    if action_filter:
        query += ' AND action = ?'
        params.append(action_filter)

    if email_search:
        query += ' AND (actor_email LIKE ? OR target_email LIKE ?)'
        params.extend([f'%{email_search}%', f'%{email_search}%'])

    # Get total count for pagination
    count_query = query.replace('SELECT *', 'SELECT COUNT(*)')
    cursor.execute(count_query, params)
    total = cursor.fetchone()[0]

    # Add ordering and pagination
    query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?'
    params.extend([per_page, (page - 1) * per_page])

    cursor.execute(query, params)
    logs = [dict(row) for row in cursor.fetchall()]
    conn.close()

    return jsonify({
        'logs': logs,
        'total': total,
        'page': page,
        'per_page': per_page,
        'total_pages': (total + per_page - 1) // per_page
    })

@app.route('/api/admin/change-credentials', methods=['POST'])
@admin_required
def change_credentials():
    data = request.get_json()
    current_password = data.get('current_password', '')
    new_email = data.get('new_email', '').strip().lower()
    new_password = data.get('new_password', '').strip()
    confirm_password = data.get('confirm_password', '')

    if not current_password:
        return jsonify({'error': 'Current password is required'}), 400

    # Validate new email if provided
    if new_email and ('@' not in new_email or '.' not in new_email):
        return jsonify({'error': 'Please enter a valid email'}), 400

    # Validate new password if provided
    if new_password:
        if new_password != confirm_password:
            return jsonify({'error': 'New passwords do not match'}), 400
        if len(new_password) < 6:
            return jsonify({'error': 'Password must be at least 6 characters'}), 400

    if not new_email and not new_password:
        return jsonify({'error': 'Please provide a new email or password'}), 400

    conn = get_db()
    cursor = conn.cursor()

    # Get the admin (assuming single admin for now, using the first one)
    cursor.execute('SELECT id, email, password FROM admins LIMIT 1')
    admin = cursor.fetchone()

    if not admin or admin['password'] != hash_password(current_password):
        conn.close()
        return jsonify({'error': 'Current password is incorrect'}), 401

    # Update credentials
    updated_email = new_email if new_email else admin['email']
    updated_password = hash_password(new_password) if new_password else admin['password']

    cursor.execute('UPDATE admins SET email = ?, password = ? WHERE id = ?',
                   (updated_email, updated_password, admin['id']))
    conn.commit()
    conn.close()

    return jsonify({'success': True, 'email': updated_email})

# Grid API
@app.route('/api/grids', methods=['GET'])
def get_grids():
    """Get list of all grids with their square counts"""
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('''
        SELECT g.id, g.name, g.numbers_locked,
               COUNT(CASE WHEN s.owner_name IS NOT NULL THEN 1 END) as squares_sold
        FROM grids g
        LEFT JOIN squares s ON g.id = s.grid_id
        WHERE g.is_active = 1
        GROUP BY g.id
        ORDER BY g.id
    ''')
    grids = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return jsonify({'grids': grids})

@app.route('/api/grid', methods=['GET'])
def get_grid():
    grid_id = request.args.get('grid_id', 1, type=int)

    conn = get_db()
    cursor = conn.cursor()

    # Get squares for this grid (don't expose emails to frontend)
    cursor.execute('''
        SELECT row, col, owner_name, claimed_at FROM squares
        WHERE grid_id = ? ORDER BY row, col
    ''', (grid_id,))
    squares = [dict(row) for row in cursor.fetchall()]

    # Get grid-specific config (numbers)
    cursor.execute('SELECT * FROM grids WHERE id = ?', (grid_id,))
    grid_row = cursor.fetchone()
    grid_config = dict(grid_row) if grid_row else {}

    # Get shared game config
    cursor.execute('SELECT * FROM game_config WHERE id = 1')
    config_row = cursor.fetchone()
    config = dict(config_row) if config_row else {}

    # Merge grid-specific numbers into config
    if grid_config.get('row_numbers'):
        config['row_numbers'] = json.loads(grid_config['row_numbers'])
    if grid_config.get('col_numbers'):
        config['col_numbers'] = json.loads(grid_config['col_numbers'])
    config['numbers_locked'] = grid_config.get('numbers_locked', 0)
    config['grid_name'] = grid_config.get('name', 'Grid 1')

    # Include locked quarters for admin UI
    locked_quarters = {
        'q1': bool(config.get('q1_locked', 0)),
        'q2': bool(config.get('q2_locked', 0)),
        'q3': bool(config.get('q3_locked', 0)),
        'q4': bool(config.get('q4_locked', 0)),
    }

    conn.close()
    return jsonify({
        'squares': squares,
        'config': config,
        'grid_id': grid_id,
        'squares_limit': config.get('squares_limit', 5),
        'claim_deadline': config.get('claim_deadline'),
        'locked_quarters': locked_quarters,
        'live_sync_enabled': bool(config.get('live_sync_enabled', 0))
    })

# Claim a square - no login required
@app.route('/api/claim', methods=['POST'])
def claim_square():
    data = request.get_json()
    grid_id = data.get('grid_id', 1)
    row = data.get('row')
    col = data.get('col')
    name = data.get('name', '').strip()
    email = data.get('email', '').strip().lower()
    player_name = data.get('player_name', '').strip()

    if row is None or col is None:
        return jsonify({'error': 'Row and column required'}), 400

    if not name or not email:
        return jsonify({'error': 'Name and email are required'}), 400

    # Basic email validation
    if '@' not in email or '.' not in email:
        return jsonify({'error': 'Please enter a valid email'}), 400

    conn = get_db()
    cursor = conn.cursor()

    # Check if claiming deadline has passed
    cursor.execute('SELECT claim_deadline FROM game_config WHERE id = 1')
    config = cursor.fetchone()
    if config and config['claim_deadline']:
        deadline = datetime.fromisoformat(config['claim_deadline'])
        if datetime.now() > deadline:
            conn.close()
            return jsonify({'error': 'The claiming deadline has passed'}), 400

    # Check if square is already claimed
    cursor.execute('SELECT owner_name FROM squares WHERE grid_id = ? AND row = ? AND col = ?', (grid_id, row, col))
    result = cursor.fetchone()

    if result and result['owner_name']:
        conn.close()
        return jsonify({'error': 'This square is already taken'}), 400

    # Get squares limit from config
    cursor.execute('SELECT squares_limit FROM game_config WHERE id = 1')
    limit_row = cursor.fetchone()
    squares_limit = limit_row['squares_limit'] if limit_row and limit_row['squares_limit'] else 5

    # Check email's square limit (across ALL grids)
    cursor.execute('SELECT COUNT(*) FROM squares WHERE owner_email = ?', (email,))
    email_square_count = cursor.fetchone()[0]
    if email_square_count >= squares_limit:
        conn.close()
        return jsonify({'error': f'This email has already claimed {squares_limit} squares (the maximum allowed)'}), 400

    # Claim the square
    cursor.execute('''
        UPDATE squares SET owner_name = ?, owner_email = ?, player_name = ?, claimed_at = ? WHERE grid_id = ? AND row = ? AND col = ?
    ''', (name, email, player_name, datetime.now().isoformat(), grid_id, row, col))

    conn.commit()
    conn.close()

    # Log the action
    log_audit('square_claimed', f'Claimed by {name}', actor_email=email, grid_id=grid_id, row=row, col=col)

    return jsonify({'success': True})

# Admin: Clear a square
@app.route('/api/admin/clear-square', methods=['POST'])
@admin_required
def clear_square():
    data = request.get_json()
    grid_id = data.get('grid_id', 1)
    row = data.get('row')
    col = data.get('col')

    conn = get_db()
    cursor = conn.cursor()

    # Get owner info before clearing for audit log
    cursor.execute('SELECT owner_name, owner_email FROM squares WHERE grid_id = ? AND row = ? AND col = ?', (grid_id, row, col))
    square = cursor.fetchone()
    target_email = square['owner_email'] if square else None
    owner_name = square['owner_name'] if square else None

    cursor.execute('''
        UPDATE squares SET owner_name = NULL, owner_email = NULL, player_name = NULL, claimed_at = NULL, paid = 0
        WHERE grid_id = ? AND row = ? AND col = ?
    ''', (grid_id, row, col))
    conn.commit()
    conn.close()

    # Log the action
    log_audit('square_cleared', f'Cleared square previously owned by {owner_name}', target_email=target_email, grid_id=grid_id, row=row, col=col)

    return jsonify({'success': True})

@app.route('/api/randomize', methods=['POST'])
@admin_required
def randomize_numbers():
    data = request.get_json()
    grid_id = data.get('grid_id', 1)

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('SELECT numbers_locked FROM grids WHERE id = ?', (grid_id,))
    result = cursor.fetchone()
    if result and result['numbers_locked']:
        conn.close()
        return jsonify({'error': 'Numbers are locked'}), 400

    row_numbers = list(range(10))
    col_numbers = list(range(10))
    random.shuffle(row_numbers)
    random.shuffle(col_numbers)

    cursor.execute('''
        UPDATE grids SET row_numbers = ?, col_numbers = ? WHERE id = ?
    ''', (json.dumps(row_numbers), json.dumps(col_numbers), grid_id))

    conn.commit()
    conn.close()

    # Log the action
    log_audit('numbers_randomized', f'Numbers randomized for grid {grid_id}', grid_id=grid_id)

    return jsonify({'row_numbers': row_numbers, 'col_numbers': col_numbers})

@app.route('/api/clear-numbers', methods=['POST'])
@admin_required
def clear_numbers():
    data = request.get_json()
    grid_id = data.get('grid_id', 1)

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('SELECT numbers_locked FROM grids WHERE id = ?', (grid_id,))
    result = cursor.fetchone()
    if result and result['numbers_locked']:
        conn.close()
        return jsonify({'error': 'Numbers are locked'}), 400

    cursor.execute('''
        UPDATE grids SET row_numbers = NULL, col_numbers = NULL WHERE id = ?
    ''', (grid_id,))

    conn.commit()
    conn.close()

    # Log the action
    log_audit('numbers_cleared', f'Numbers cleared for grid {grid_id}', grid_id=grid_id)

    return jsonify({'success': True})

@app.route('/api/lock-numbers', methods=['POST'])
@admin_required
def lock_numbers():
    data = request.get_json()
    grid_id = data.get('grid_id', 1)

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('UPDATE grids SET numbers_locked = 1 WHERE id = ?', (grid_id,))
    conn.commit()
    conn.close()

    # Log the action
    log_audit('numbers_locked', f'Numbers locked for grid {grid_id}', grid_id=grid_id)

    return jsonify({'success': True})

@app.route('/api/config', methods=['POST'])
@admin_required
def update_config():
    data = request.get_json()
    conn = get_db()
    cursor = conn.cursor()

    changes = []

    if 'team1_name' in data:
        cursor.execute('UPDATE game_config SET team1_name = ? WHERE id = 1', (data['team1_name'],))
        changes.append(f"team1_name={data['team1_name']}")
    if 'team2_name' in data:
        cursor.execute('UPDATE game_config SET team2_name = ? WHERE id = 1', (data['team2_name'],))
        changes.append(f"team2_name={data['team2_name']}")
    if 'price_per_square' in data:
        cursor.execute('UPDATE game_config SET price_per_square = ? WHERE id = 1', (data['price_per_square'],))
        changes.append(f"price_per_square={data['price_per_square']}")
    if 'squares_limit' in data:
        cursor.execute('UPDATE game_config SET squares_limit = ? WHERE id = 1', (data['squares_limit'],))
        changes.append(f"squares_limit={data['squares_limit']}")
    if 'show_winners' in data:
        cursor.execute('UPDATE game_config SET show_winners = ? WHERE id = 1', (1 if data['show_winners'] else 0,))
        changes.append(f"show_winners={data['show_winners']}")
    if 'claim_deadline' in data:
        cursor.execute('UPDATE game_config SET claim_deadline = ? WHERE id = 1', (data['claim_deadline'] if data['claim_deadline'] else None,))
        changes.append(f"claim_deadline={data['claim_deadline']}")

    # Prize percentages
    for field in ['prize_q1', 'prize_q2', 'prize_q3', 'prize_q4']:
        if field in data:
            cursor.execute(f'UPDATE game_config SET {field} = ? WHERE id = 1', (data[field],))
            changes.append(f"{field}={data[field]}")

    conn.commit()
    conn.close()

    # Log the action if changes were made
    if changes:
        log_audit('config_changed', ', '.join(changes))

    return jsonify({'success': True})

@app.route('/api/scores', methods=['POST'])
@admin_required
def update_scores():
    data = request.get_json()
    conn = get_db()
    cursor = conn.cursor()

    fields = ['q1_team1', 'q1_team2', 'q2_team1', 'q2_team2',
              'q3_team1', 'q3_team2', 'q4_team1', 'q4_team2']

    for field in fields:
        if field in data:
            value = data[field] if data[field] != '' else None
            cursor.execute(f'UPDATE game_config SET {field} = ? WHERE id = 1', (value,))

    conn.commit()
    conn.close()
    return jsonify({'success': True})


def fetch_espn_nfl_scores():
    """Fetch current NFL scores from ESPN API"""
    url = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard'
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode('utf-8'))
            return data
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError) as e:
        print(f"Error fetching ESPN data: {e}")
        return None


def parse_espn_game(game_data, team1_name, team2_name):
    """Parse ESPN game data to extract scores and status"""
    result = {
        'game_id': game_data.get('id'),
        'status': None,
        'period': None,
        'clock': None,
        'team1_score': None,
        'team2_score': None,
        'team1_name_espn': None,
        'team2_name_espn': None,
        'linescores': {'team1': [], 'team2': []},
        'is_final': False,
        'is_halftime': False,
        'quarter_scores': {}
    }

    # Get competition data
    competitions = game_data.get('competitions', [])
    if not competitions:
        return result

    competition = competitions[0]

    # Get status
    status_obj = competition.get('status', {})
    status_type = status_obj.get('type', {})
    result['status'] = status_type.get('description', 'Unknown')
    result['period'] = status_obj.get('period', 0)
    result['clock'] = status_obj.get('displayClock', '')
    result['is_final'] = status_type.get('completed', False)
    result['is_halftime'] = status_type.get('name') == 'STATUS_HALFTIME'

    # Get competitors (teams)
    competitors = competition.get('competitors', [])
    team1_data = None
    team2_data = None

    for comp in competitors:
        team_info = comp.get('team', {})
        team_name_espn = team_info.get('displayName', '') or team_info.get('name', '')
        team_abbrev = team_info.get('abbreviation', '')

        # Match teams by checking if our team name contains the ESPN team name or abbreviation
        team1_lower = team1_name.lower() if team1_name else ''
        team2_lower = team2_name.lower() if team2_name else ''
        espn_lower = team_name_espn.lower()
        abbrev_lower = team_abbrev.lower()

        if (espn_lower in team1_lower or team1_lower in espn_lower or
            abbrev_lower in team1_lower or team1_lower in abbrev_lower or
            any(word in team1_lower for word in espn_lower.split())):
            team1_data = comp
            result['team1_name_espn'] = team_name_espn
        elif (espn_lower in team2_lower or team2_lower in espn_lower or
              abbrev_lower in team2_lower or team2_lower in abbrev_lower or
              any(word in team2_lower for word in espn_lower.split())):
            team2_data = comp
            result['team2_name_espn'] = team_name_espn

    # Extract scores
    if team1_data:
        result['team1_score'] = int(team1_data.get('score', 0) or 0)
        linescores = team1_data.get('linescores', [])
        result['linescores']['team1'] = [int(ls.get('value', 0)) for ls in linescores]

    if team2_data:
        result['team2_score'] = int(team2_data.get('score', 0) or 0)
        linescores = team2_data.get('linescores', [])
        result['linescores']['team2'] = [int(ls.get('value', 0)) for ls in linescores]

    # Calculate cumulative scores for each quarter
    t1_cumulative = 0
    t2_cumulative = 0
    for i in range(4):
        if i < len(result['linescores']['team1']):
            t1_cumulative += result['linescores']['team1'][i]
        if i < len(result['linescores']['team2']):
            t2_cumulative += result['linescores']['team2'][i]

        quarter = i + 1
        result['quarter_scores'][f'q{quarter}_team1'] = t1_cumulative
        result['quarter_scores'][f'q{quarter}_team2'] = t2_cumulative

    return result


def find_super_bowl_game(espn_data, team1_name, team2_name):
    """Find the Super Bowl game from ESPN data based on team names"""
    if not espn_data or 'events' not in espn_data:
        return None

    for event in espn_data['events']:
        # Check if this is a Super Bowl (usually has "Super Bowl" in the name)
        event_name = event.get('name', '').lower()
        short_name = event.get('shortName', '').lower()

        # Try to match by team names first
        parsed = parse_espn_game(event, team1_name, team2_name)
        if parsed['team1_name_espn'] and parsed['team2_name_espn']:
            return parsed

        # Check if it's explicitly a Super Bowl
        if 'super bowl' in event_name or 'super bowl' in short_name:
            return parse_espn_game(event, team1_name, team2_name)

    return None


@app.route('/api/live-scores', methods=['GET'])
def get_live_scores():
    """Fetch live scores from ESPN and return current game state"""
    conn = get_db()
    cursor = conn.cursor()

    # Get current config including team names
    cursor.execute('''SELECT team1_name, team2_name, espn_game_id,
                      q1_locked, q2_locked, q3_locked, q4_locked,
                      live_sync_enabled,
                      q1_team1, q1_team2, q2_team1, q2_team2,
                      q3_team1, q3_team2, q4_team1, q4_team2
                      FROM game_config WHERE id = 1''')
    config = cursor.fetchone()
    conn.close()

    if not config:
        return jsonify({'error': 'No game configuration found'}), 404

    team1_name = config['team1_name']
    team2_name = config['team2_name']

    # Fetch from ESPN
    espn_data = fetch_espn_nfl_scores()
    if not espn_data:
        return jsonify({
            'error': 'Could not fetch live scores',
            'cached_scores': {
                'q1_team1': config['q1_team1'], 'q1_team2': config['q1_team2'],
                'q2_team1': config['q2_team1'], 'q2_team2': config['q2_team2'],
                'q3_team1': config['q3_team1'], 'q3_team2': config['q3_team2'],
                'q4_team1': config['q4_team1'], 'q4_team2': config['q4_team2'],
            },
            'locked_quarters': {
                'q1': bool(config['q1_locked']),
                'q2': bool(config['q2_locked']),
                'q3': bool(config['q3_locked']),
                'q4': bool(config['q4_locked']),
            }
        }), 503

    # Find the game with our teams
    game = find_super_bowl_game(espn_data, team1_name, team2_name)

    if not game:
        return jsonify({
            'error': 'Game not yet available - live scores will appear on game day',
            'error_type': 'game_not_found',
            'team1_name': team1_name,
            'team2_name': team2_name,
            'available_games': [
                {
                    'name': e.get('name', 'Unknown'),
                    'teams': [c.get('team', {}).get('displayName', '')
                             for c in e.get('competitions', [{}])[0].get('competitors', [])]
                }
                for e in espn_data.get('events', [])
            ]
        }), 404

    return jsonify({
        'success': True,
        'game': {
            'game_id': game['game_id'],
            'status': game['status'],
            'period': game['period'],
            'clock': game['clock'],
            'is_final': game['is_final'],
            'is_halftime': game['is_halftime'],
            'team1_score': game['team1_score'],
            'team2_score': game['team2_score'],
            'team1_name_espn': game['team1_name_espn'],
            'team2_name_espn': game['team2_name_espn'],
            'quarter_scores': game['quarter_scores'],
            'linescores': game['linescores']
        },
        'locked_quarters': {
            'q1': bool(config['q1_locked']),
            'q2': bool(config['q2_locked']),
            'q3': bool(config['q3_locked']),
            'q4': bool(config['q4_locked']),
        },
        'live_sync_enabled': bool(config['live_sync_enabled']),
        'saved_scores': {
            'q1_team1': config['q1_team1'], 'q1_team2': config['q1_team2'],
            'q2_team1': config['q2_team1'], 'q2_team2': config['q2_team2'],
            'q3_team1': config['q3_team1'], 'q3_team2': config['q3_team2'],
            'q4_team1': config['q4_team1'], 'q4_team2': config['q4_team2'],
        }
    })


@app.route('/api/admin/sync-live-scores', methods=['POST'])
@admin_required
def sync_live_scores():
    """Sync live scores from ESPN to the database"""
    data = request.get_json() or {}
    force_quarter = data.get('force_quarter')  # Optional: force sync a specific quarter

    conn = get_db()
    cursor = conn.cursor()

    # Get current config
    cursor.execute('''SELECT team1_name, team2_name,
                      q1_locked, q2_locked, q3_locked, q4_locked
                      FROM game_config WHERE id = 1''')
    config = cursor.fetchone()

    if not config:
        conn.close()
        return jsonify({'error': 'No game configuration found'}), 404

    # Fetch from ESPN
    espn_data = fetch_espn_nfl_scores()
    if not espn_data:
        conn.close()
        return jsonify({'error': 'Could not fetch live scores from ESPN'}), 503

    game = find_super_bowl_game(espn_data, config['team1_name'], config['team2_name'])
    if not game:
        conn.close()
        return jsonify({'error': 'Game not yet available - live scores will appear on game day'}), 404

    # Determine which quarters to update
    updates = []
    quarter_updates = {}

    # Q1: Update if period > 1 or halftime or final, and not locked (unless forced)
    if (game['period'] > 1 or game['is_halftime'] or game['is_final']):
        if not config['q1_locked'] or force_quarter == 1:
            quarter_updates['q1_team1'] = game['quarter_scores'].get('q1_team1')
            quarter_updates['q1_team2'] = game['quarter_scores'].get('q1_team2')
            if not config['q1_locked']:
                cursor.execute('UPDATE game_config SET q1_locked = 1 WHERE id = 1')
            updates.append('Q1')

    # Q2: Update if period > 2 or final (halftime means Q2 is done)
    if (game['period'] > 2 or game['is_final'] or game['is_halftime']):
        if not config['q2_locked'] or force_quarter == 2:
            quarter_updates['q2_team1'] = game['quarter_scores'].get('q2_team1')
            quarter_updates['q2_team2'] = game['quarter_scores'].get('q2_team2')
            if not config['q2_locked']:
                cursor.execute('UPDATE game_config SET q2_locked = 1 WHERE id = 1')
            updates.append('Q2')

    # Q3: Update if period > 3 or final
    if (game['period'] > 3 or game['is_final']):
        if not config['q3_locked'] or force_quarter == 3:
            quarter_updates['q3_team1'] = game['quarter_scores'].get('q3_team1')
            quarter_updates['q3_team2'] = game['quarter_scores'].get('q3_team2')
            if not config['q3_locked']:
                cursor.execute('UPDATE game_config SET q3_locked = 1 WHERE id = 1')
            updates.append('Q3')

    # Q4/Final: Update if game is final
    if game['is_final']:
        if not config['q4_locked'] or force_quarter == 4:
            quarter_updates['q4_team1'] = game['quarter_scores'].get('q4_team1')
            quarter_updates['q4_team2'] = game['quarter_scores'].get('q4_team2')
            if not config['q4_locked']:
                cursor.execute('UPDATE game_config SET q4_locked = 1 WHERE id = 1')
            updates.append('Q4/Final')

    # Apply score updates
    for field, value in quarter_updates.items():
        if value is not None:
            cursor.execute(f'UPDATE game_config SET {field} = ? WHERE id = 1', (value,))

    conn.commit()
    conn.close()

    # Log the sync
    if updates:
        log_audit('live_scores_synced', f'Synced {", ".join(updates)} from ESPN')

    # Trigger emails for newly locked quarters
    for quarter_label in updates:
        if 'Final' in quarter_label:
            q_num = 4
        else:
            q_num = int(quarter_label[1])
        send_quarter_emails_async(q_num)

    return jsonify({
        'success': True,
        'updated_quarters': updates,
        'scores': quarter_updates,
        'game_status': game['status'],
        'period': game['period'],
        'is_final': game['is_final']
    })


@app.route('/api/admin/live-sync-toggle', methods=['POST'])
@admin_required
def toggle_live_sync():
    """Enable or disable automatic live score syncing"""
    data = request.get_json()
    enabled = data.get('enabled', False)

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('UPDATE game_config SET live_sync_enabled = ? WHERE id = 1', (1 if enabled else 0,))
    conn.commit()
    conn.close()

    log_audit('live_sync_toggled', f'Live sync {"enabled" if enabled else "disabled"}')

    return jsonify({'success': True, 'live_sync_enabled': enabled})


@app.route('/api/admin/unlock-quarter', methods=['POST'])
@admin_required
def unlock_quarter():
    """Unlock a quarter to allow manual override of scores"""
    data = request.get_json()
    quarter = data.get('quarter')

    if quarter not in [1, 2, 3, 4]:
        return jsonify({'error': 'Invalid quarter'}), 400

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(f'UPDATE game_config SET q{quarter}_locked = 0 WHERE id = 1')
    conn.commit()
    conn.close()

    log_audit('quarter_unlocked', f'Q{quarter} unlocked for manual override')

    return jsonify({'success': True, 'quarter': quarter})


@app.route('/api/admin/lock-quarter', methods=['POST'])
@admin_required
def lock_quarter():
    """Manually lock a quarter's scores"""
    data = request.get_json()
    quarter = data.get('quarter')

    if quarter not in [1, 2, 3, 4]:
        return jsonify({'error': 'Invalid quarter'}), 400

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(f'UPDATE game_config SET q{quarter}_locked = 1 WHERE id = 1')
    conn.commit()
    conn.close()

    log_audit('quarter_locked', f'Q{quarter} manually locked')

    return jsonify({'success': True, 'quarter': quarter})

@app.route('/api/admin/email-toggle', methods=['POST'])
@admin_required
def toggle_emails():
    """Toggle email notifications on/off"""
    data = request.get_json()
    enabled = data.get('enabled', False)

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('UPDATE game_config SET emails_enabled = ? WHERE id = 1', (1 if enabled else 0,))
    conn.commit()
    conn.close()

    log_audit('config_changed', f'Email notifications {"enabled" if enabled else "disabled"}')
    return jsonify({'success': True, 'emails_enabled': enabled})


@app.route('/api/admin/email-status', methods=['GET'])
@admin_required
def email_status():
    """Get email send counts per quarter"""
    conn = get_db()
    cursor = conn.cursor()

    # Get emails_enabled state
    cursor.execute('SELECT emails_enabled FROM game_config WHERE id = 1')
    config = cursor.fetchone()
    emails_enabled = bool(config['emails_enabled']) if config else False

    # Get counts per quarter
    quarters = {}
    for q in range(1, 5):
        cursor.execute(
            'SELECT status, COUNT(*) as cnt FROM email_sends WHERE quarter = ? GROUP BY status',
            (q,)
        )
        counts = {'sent': 0, 'failed': 0, 'pending': 0}
        for row in cursor.fetchall():
            counts[row['status']] = row['cnt']
        quarters[f'q{q}'] = counts

    conn.close()
    return jsonify({'emails_enabled': emails_enabled, 'quarters': quarters})


@app.route('/api/admin/resend-emails', methods=['POST'])
@admin_required
def resend_emails():
    """Delete existing email records for a quarter and re-trigger sending"""
    data = request.get_json()
    quarter = data.get('quarter')

    if quarter not in [1, 2, 3, 4]:
        return jsonify({'error': 'Invalid quarter'}), 400

    conn = get_db()
    cursor = conn.cursor()

    # Delete existing records for this quarter
    cursor.execute('DELETE FROM email_sends WHERE quarter = ?', (quarter,))
    conn.commit()
    conn.close()

    log_audit('emails_resend', f'Resending emails for Q{quarter}')

    # Trigger email sending
    send_quarter_emails_async(quarter)

    return jsonify({'success': True, 'quarter': quarter})


@app.route('/api/reset', methods=['POST'])
@admin_required
def reset_game():
    conn = get_db()
    cursor = conn.cursor()

    # Clear all squares across all grids
    cursor.execute('UPDATE squares SET owner_name = NULL, owner_email = NULL, player_name = NULL, claimed_at = NULL, paid = 0')

    # Reset all grids' numbers
    cursor.execute('UPDATE grids SET row_numbers = NULL, col_numbers = NULL, numbers_locked = 0')

    # Reset scores, locked quarters, and email settings
    cursor.execute('''
        UPDATE game_config SET
            q1_team1 = NULL, q1_team2 = NULL,
            q2_team1 = NULL, q2_team2 = NULL,
            q3_team1 = NULL, q3_team2 = NULL,
            q4_team1 = NULL, q4_team2 = NULL,
            q1_locked = 0, q2_locked = 0,
            q3_locked = 0, q4_locked = 0,
            live_sync_enabled = 0,
            emails_enabled = 0
        WHERE id = 1
    ''')

    # Clear email send history
    cursor.execute('DELETE FROM email_sends')

    conn.commit()
    conn.close()

    # Log the action
    log_audit('game_reset', 'All squares, numbers, and scores cleared')

    return jsonify({'success': True})

# Admin: Create a new grid
@app.route('/api/admin/grids', methods=['POST'])
@admin_required
def admin_create_grid():
    data = request.get_json()
    name = data.get('name', '').strip()

    if not name:
        # Auto-generate name
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('SELECT COUNT(*) FROM grids')
        count = cursor.fetchone()[0]
        conn.close()
        name = f'Grid {count + 1}'

    grid_id = create_grid(name)
    return jsonify({'success': True, 'grid_id': grid_id, 'name': name})

# Admin: Delete a grid
@app.route('/api/admin/grids/<int:grid_id>', methods=['DELETE'])
@admin_required
def admin_delete_grid(grid_id):
    if grid_id == 1:
        return jsonify({'error': 'Cannot delete the primary grid'}), 400

    conn = get_db()
    cursor = conn.cursor()

    # Delete squares for this grid
    cursor.execute('DELETE FROM squares WHERE grid_id = ?', (grid_id,))

    # Delete the grid
    cursor.execute('DELETE FROM grids WHERE id = ?', (grid_id,))

    conn.commit()
    conn.close()
    return jsonify({'success': True})

# Admin: Upload team logo
@app.route('/api/admin/upload-logo', methods=['POST'])
@admin_required
def upload_logo():
    team = request.form.get('team')
    if team not in ['1', '2']:
        return jsonify({'error': 'Invalid team'}), 400

    if 'logo' not in request.files:
        return jsonify({'error': 'No file uploaded'}), 400

    file = request.files['logo']
    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400

    # Read file and convert to base64
    import base64
    file_data = file.read()

    # Limit file size (500KB)
    if len(file_data) > 500 * 1024:
        return jsonify({'error': 'File too large. Maximum size is 500KB'}), 400

    # Get mime type
    content_type = file.content_type or 'image/png'
    base64_data = base64.b64encode(file_data).decode('utf-8')
    data_url = f"data:{content_type};base64,{base64_data}"

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(f'UPDATE game_config SET team{team}_logo = ? WHERE id = 1', (data_url,))
    conn.commit()
    conn.close()

    return jsonify({'success': True, 'logo_url': data_url})

# Admin: Get team logos and colors
@app.route('/api/logos', methods=['GET'])
def get_logos():
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('SELECT team1_logo, team2_logo, team1_color, team2_color FROM game_config WHERE id = 1')
    row = cursor.fetchone()
    conn.close()

    return jsonify({
        'team1_logo': row['team1_logo'] if row else None,
        'team2_logo': row['team2_logo'] if row else None,
        'team1_color': row['team1_color'] if row and row['team1_color'] else '#0060aa',
        'team2_color': row['team2_color'] if row and row['team2_color'] else '#cc0000'
    })

# Admin: Update team color
@app.route('/api/admin/team-color', methods=['POST'])
@admin_required
def update_team_color():
    data = request.get_json()
    team = data.get('team')
    color = data.get('color')

    if team not in ['1', '2']:
        return jsonify({'error': 'Invalid team'}), 400

    if not color or not color.startswith('#'):
        return jsonify({'error': 'Invalid color'}), 400

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(f'UPDATE game_config SET team{team}_color = ? WHERE id = 1', (color,))
    conn.commit()
    conn.close()

    return jsonify({'success': True})

# Admin: Get all participants grouped by email
@app.route('/api/admin/participants', methods=['GET'])
@admin_required
def get_participants():
    conn = get_db()
    cursor = conn.cursor()

    # Get all claimed squares with owner info
    cursor.execute('''
        SELECT s.owner_email, s.owner_name, s.player_name, s.paid, s.grid_id, s.row, s.col, s.claimed_at, g.name as grid_name
        FROM squares s
        JOIN grids g ON s.grid_id = g.id
        WHERE s.owner_email IS NOT NULL
        ORDER BY s.owner_email, s.grid_id, s.row, s.col
    ''')

    rows = cursor.fetchall()

    # Get price per square
    cursor.execute('SELECT price_per_square FROM game_config WHERE id = 1')
    config = cursor.fetchone()
    price_per_square = config['price_per_square'] if config else 10.0

    conn.close()

    # Group by email
    participants = {}
    for row in rows:
        email = row['owner_email']
        if email not in participants:
            participants[email] = {
                'email': email,
                'name': row['owner_name'],
                'player_name': row['player_name'],
                'squares': [],
                'total_squares': 0,
                'paid_squares': 0,
                'amount_owed': 0,
                'first_claimed_at': row['claimed_at']
            }

        # Track earliest claimed date
        if row['claimed_at'] and (not participants[email]['first_claimed_at'] or row['claimed_at'] < participants[email]['first_claimed_at']):
            participants[email]['first_claimed_at'] = row['claimed_at']

        participants[email]['squares'].append({
            'grid_id': row['grid_id'],
            'grid_name': row['grid_name'],
            'row': row['row'],
            'col': row['col'],
            'paid': row['paid'],
            'claimed_at': row['claimed_at']
        })
        participants[email]['total_squares'] += 1
        if row['paid']:
            participants[email]['paid_squares'] += 1

    # Calculate amounts
    for p in participants.values():
        p['amount_owed'] = (p['total_squares'] - p['paid_squares']) * price_per_square
        p['all_paid'] = p['paid_squares'] == p['total_squares']

    return jsonify({
        'participants': list(participants.values()),
        'price_per_square': price_per_square
    })

# Admin: Toggle paid status for a participant (by email)
@app.route('/api/admin/participants/toggle-paid', methods=['POST'])
@admin_required
def toggle_participant_paid():
    data = request.get_json()
    email = data.get('email', '').strip().lower()
    paid = data.get('paid', True)  # True to mark as paid, False to mark as unpaid

    if not email:
        return jsonify({'error': 'Email is required'}), 400

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('''
        UPDATE squares SET paid = ? WHERE owner_email = ?
    ''', (1 if paid else 0, email))

    affected = cursor.rowcount
    conn.commit()
    conn.close()

    # Log the action
    action = 'payment_marked_paid' if paid else 'payment_marked_unpaid'
    log_audit(action, f'{affected} squares updated', target_email=email)

    return jsonify({'success': True, 'affected_squares': affected})

# Admin: Bulk mark paid/unpaid for multiple participants
@app.route('/api/admin/participants/bulk-mark-paid', methods=['POST'])
@admin_required
def bulk_mark_paid():
    data = request.get_json()
    emails = data.get('emails', [])
    paid = data.get('paid', True)

    if not emails:
        return jsonify({'error': 'No emails provided'}), 400

    conn = get_db()
    cursor = conn.cursor()

    total_affected = 0
    audit_entries = []
    for email in emails:
        email = email.strip().lower()
        cursor.execute('UPDATE squares SET paid = ? WHERE owner_email = ?', (1 if paid else 0, email))
        affected = cursor.rowcount
        total_affected += affected
        audit_entries.append((email, affected))

    conn.commit()
    conn.close()

    # Log after commit to avoid database lock
    action = 'payment_marked_paid' if paid else 'payment_marked_unpaid'
    for email, affected in audit_entries:
        log_audit(action, f'{affected} squares updated (bulk)', target_email=email)

    return jsonify({'success': True, 'affected_squares': total_affected, 'emails_processed': len(emails)})

# Admin: Update player name for a participant
@app.route('/api/admin/participants/update-player', methods=['POST'])
@admin_required
def update_participant_player():
    data = request.get_json()
    email = data.get('email', '').strip().lower()
    player_name = data.get('player_name', '').strip()

    if not email:
        return jsonify({'error': 'Email is required'}), 400

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('UPDATE squares SET player_name = ? WHERE owner_email = ?', (player_name if player_name else None, email))
    affected = cursor.rowcount
    conn.commit()
    conn.close()

    log_audit('config_changed', f'Player name updated to "{player_name}" for {email}', target_email=email)

    return jsonify({'success': True, 'affected_squares': affected})

# Admin: Get player support totals
@app.route('/api/admin/player-totals', methods=['GET'])
@admin_required
def get_player_totals():
    conn = get_db()
    cursor = conn.cursor()

    # Get price per square
    cursor.execute('SELECT price_per_square FROM game_config WHERE id = 1')
    config = cursor.fetchone()
    price = config['price_per_square'] if config and config['price_per_square'] else 10

    # Get totals grouped by player_name
    cursor.execute('''
        SELECT
            COALESCE(player_name, 'Not specified') as player,
            COUNT(*) as square_count,
            SUM(CASE WHEN paid = 1 THEN 1 ELSE 0 END) as paid_count
        FROM squares
        WHERE owner_name IS NOT NULL
        GROUP BY COALESCE(player_name, 'Not specified')
        ORDER BY COUNT(*) DESC
    ''')

    totals = []
    for row in cursor.fetchall():
        totals.append({
            'player': row['player'],
            'square_count': row['square_count'],
            'paid_count': row['paid_count'],
            'total_amount': row['square_count'] * price,
            'paid_amount': row['paid_count'] * price
        })

    conn.close()
    return jsonify({'totals': totals, 'price_per_square': price})

# Public: Get squares for a specific email (for "Find Your Squares" feature)
@app.route('/api/my-squares', methods=['GET'])
def get_my_squares():
    email = request.args.get('email', '').strip().lower()
    grid_id = request.args.get('grid_id', 1, type=int)

    if not email:
        return jsonify({'error': 'Email is required'}), 400

    conn = get_db()
    cursor = conn.cursor()

    # Get squares owned by this email on the specified grid
    cursor.execute('''
        SELECT row, col FROM squares
        WHERE grid_id = ? AND owner_email = ?
    ''', (grid_id, email))

    squares = [{'row': row['row'], 'col': row['col']} for row in cursor.fetchall()]

    # Also get total count across all grids for this email
    cursor.execute('SELECT COUNT(*) FROM squares WHERE owner_email = ?', (email,))
    total_count = cursor.fetchone()[0]

    conn.close()

    return jsonify({
        'squares': squares,
        'count': len(squares),
        'total_across_grids': total_count
    })

# Admin: Export unpaid participants as CSV
@app.route('/api/admin/participants/export-unpaid', methods=['GET'])
@admin_required
def export_unpaid_participants():
    conn = get_db()
    cursor = conn.cursor()

    # Get price per square
    cursor.execute('SELECT price_per_square FROM game_config WHERE id = 1')
    config = cursor.fetchone()
    price_per_square = config['price_per_square'] if config else 10.0

    # Get all unpaid squares grouped by email with earliest claimed date
    cursor.execute('''
        SELECT owner_email, owner_name, player_name, COUNT(*) as unpaid_squares, MIN(claimed_at) as first_claimed
        FROM squares
        WHERE owner_email IS NOT NULL AND (paid = 0 OR paid IS NULL)
        GROUP BY owner_email
        ORDER BY owner_name
    ''')

    rows = cursor.fetchall()
    conn.close()

    # Build CSV
    csv_lines = ['Name,Email,Supporting Player,Unpaid Squares,Amount Owed,First Claimed']
    for row in rows:
        amount = row['unpaid_squares'] * price_per_square
        player_name = row['player_name'] if row['player_name'] else ''
        first_claimed = row['first_claimed'] if row['first_claimed'] else ''
        # Format the date if present (convert ISO to readable format)
        if first_claimed:
            try:
                from datetime import datetime
                dt = datetime.fromisoformat(first_claimed.replace('Z', '+00:00'))
                first_claimed = dt.strftime('%m/%d/%Y')
            except:
                pass
        csv_lines.append(f"{row['owner_name']},{row['owner_email']},{player_name},{row['unpaid_squares']},${amount:.2f},{first_claimed}")

    csv_content = '\n'.join(csv_lines)

    from flask import Response
    return Response(
        csv_content,
        mimetype='text/csv',
        headers={'Content-Disposition': 'attachment; filename=unpaid_participants.csv'}
    )

# ==========================================
# Email Notification Functions
# ==========================================

def calculate_quarter_winner(quarter, grid_id, conn):
    """Calculate who won a given quarter on a given grid"""
    cursor = conn.cursor()

    # Get scores for this quarter
    cursor.execute(f'SELECT q{quarter}_team1, q{quarter}_team2, team1_name, team2_name FROM game_config WHERE id = 1')
    config = cursor.fetchone()
    if not config or config[f'q{quarter}_team1'] is None or config[f'q{quarter}_team2'] is None:
        return None

    team1_score = int(config[f'q{quarter}_team1'])
    team2_score = int(config[f'q{quarter}_team2'])

    # Get grid numbers
    cursor.execute('SELECT row_numbers, col_numbers FROM grids WHERE id = ?', (grid_id,))
    grid = cursor.fetchone()
    if not grid or not grid['row_numbers'] or not grid['col_numbers']:
        return None

    col_numbers = json.loads(grid['col_numbers'])
    row_numbers = json.loads(grid['row_numbers'])

    # Find winning position
    team1_last_digit = team1_score % 10
    team2_last_digit = team2_score % 10

    if team1_last_digit not in col_numbers or team2_last_digit not in row_numbers:
        return None

    col = col_numbers.index(team1_last_digit)
    row = row_numbers.index(team2_last_digit)

    # Find square owner
    cursor.execute('SELECT owner_name, owner_email FROM squares WHERE grid_id = ? AND row = ? AND col = ?', (grid_id, row, col))
    square = cursor.fetchone()

    return {
        'owner_name': square['owner_name'] if square and square['owner_name'] else None,
        'owner_email': square['owner_email'] if square and square['owner_email'] else None,
        'row': row,
        'col': col,
        'team1_score': team1_score,
        'team2_score': team2_score,
        'team1_name': config['team1_name'] or 'Team 1',
        'team2_name': config['team2_name'] or 'Team 2',
        'grid_id': grid_id
    }


def calculate_prize_amount(quarter, conn):
    """Calculate the prize amount for a quarter based on total squares sold"""
    cursor = conn.cursor()

    # Count all claimed squares across all grids
    cursor.execute('SELECT COUNT(*) FROM squares WHERE owner_name IS NOT NULL')
    total_claimed = cursor.fetchone()[0]

    cursor.execute('SELECT price_per_square, prize_q1, prize_q2, prize_q3, prize_q4 FROM game_config WHERE id = 1')
    config = cursor.fetchone()
    if not config:
        return 0

    price = config['price_per_square'] or 10
    total_pot = total_claimed * price

    pct_field = f'prize_q{quarter}'
    pct = config[pct_field] or 10
    return total_pot * (pct / 100)


def send_email(to_email, subject, html_body, text_body):
    """Send an email via Gmail SMTP. Returns (success, error_msg)."""
    if not GMAIL_ADDRESS or not GMAIL_APP_PASSWORD:
        return False, 'Gmail credentials not configured'

    msg = MIMEMultipart('alternative')
    msg['From'] = GMAIL_ADDRESS
    msg['To'] = to_email
    msg['Subject'] = subject

    msg.attach(MIMEText(text_body, 'plain'))
    msg.attach(MIMEText(html_body, 'html'))

    try:
        with smtplib.SMTP_SSL('smtp.gmail.com', 465) as server:
            server.login(GMAIL_ADDRESS, GMAIL_APP_PASSWORD)
            server.sendmail(GMAIL_ADDRESS, to_email, msg.as_string())
        return True, None
    except Exception as e:
        return False, str(e)


def send_winner_email(recipient_email, recipient_name, quarter, team1_name, team2_name, team1_score, team2_score, prize_amount, grid_name):
    """Build and send a winner notification email"""
    is_final = (quarter == 4)
    q_label = 'Q4 / Final' if is_final else f'Q{quarter}'
    subject = f"You Won {q_label}! - Super Bowl Squares"

    final_note = "<p>Thanks for being part of our fundraiser! We hope you enjoyed the game.</p>" if is_final else "<p>Your squares are still in play for the remaining quarters. Good luck!</p>"

    html_body = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h1 style="color: #2e7d32; text-align: center;">Congratulations, {recipient_name}!</h1>
        <div style="background: #e8f5e9; border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0;">
            <h2 style="margin: 0 0 10px 0;">You won {q_label}!</h2>
            <p style="font-size: 18px; margin: 5px 0;">{team1_name}: {team1_score} &mdash; {team2_name}: {team2_score}</p>
            <p style="font-size: 14px; color: #666;">Grid: {grid_name}</p>
            <p style="font-size: 24px; font-weight: bold; color: #2e7d32; margin: 15px 0;">Prize: ${prize_amount:.2f}</p>
        </div>
        <div style="background: #f5f5f5; border-radius: 8px; padding: 15px; margin: 20px 0;">
            <h3 style="margin-top: 0;">Payout Instructions</h3>
            <p>Your prize will be sent via Venmo from <strong>@susan-mui-1</strong>. Please make sure your Venmo account is set up to receive payments.</p>
        </div>
        {final_note}
        <p style="text-align: center; margin-top: 30px;">
            <a href="https://www.peglegsfundraiser.org/" style="background: #1a73e8; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">View the Board &amp; Winners</a>
        </p>
        <p style="text-align: center; color: #888; font-size: 12px; margin-top: 20px;">Stuyvesant Peglegs Super Bowl LX Squares Fundraiser</p>
    </div>
    """

    text_body = f"""Congratulations, {recipient_name}!

You won {q_label}!

{team1_name}: {team1_score} - {team2_name}: {team2_score}
Grid: {grid_name}
Prize: ${prize_amount:.2f}

Your prize will be sent via Venmo from @susan-mui-1.

{'Thanks for being part of our fundraiser!' if is_final else 'Your squares are still in play for the remaining quarters. Good luck!'}

Check the board and winners at: https://www.peglegsfundraiser.org/
"""

    return send_email(recipient_email, subject, html_body, text_body)


def send_participant_email(recipient_email, recipient_name, quarter, team1_name, team2_name, team1_score, team2_score, is_final):
    """Build and send a participant update email"""
    q_label = 'Q4 / Final' if is_final else f'Q{quarter}'
    subject = f"{q_label} Update - Super Bowl Squares"

    if is_final:
        status_msg_html = "<p>The game is over! Thanks for participating in our fundraiser and supporting Stuyvesant Baseball. Your donation makes a difference!</p>"
        status_msg_text = "The game is over! Thanks for participating in our fundraiser and supporting Stuyvesant Baseball. Your donation makes a difference!"
    else:
        status_msg_html = "<p>Your squares are still in play for the remaining quarters. Good luck!</p>"
        status_msg_text = "Your squares are still in play for the remaining quarters. Good luck!"

    html_body = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h1 style="text-align: center;">{q_label} Scores Are In!</h1>
        <div style="background: #e3f2fd; border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0;">
            <p style="font-size: 18px; margin: 5px 0;">{team1_name}: {team1_score} &mdash; {team2_name}: {team2_score}</p>
        </div>
        {status_msg_html}
        <p style="text-align: center; margin-top: 30px;">
            <a href="https://www.peglegsfundraiser.org/" style="background: #1a73e8; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Check the Board &amp; Winners</a>
        </p>
        <p style="text-align: center; color: #888; font-size: 12px; margin-top: 20px;">Stuyvesant Peglegs Super Bowl LX Squares Fundraiser</p>
    </div>
    """

    text_body = f"""{q_label} Scores Are In!

{team1_name}: {team1_score} - {team2_name}: {team2_score}

{status_msg_text}

Check the board and winners at: https://www.peglegsfundraiser.org/
"""

    return send_email(recipient_email, subject, html_body, text_body)


def send_quarter_emails(quarter):
    """Orchestrate sending winner + participant emails for a quarter"""
    conn = get_db()
    cursor = conn.cursor()

    # Check if emails are enabled
    cursor.execute('SELECT emails_enabled FROM game_config WHERE id = 1')
    config = cursor.fetchone()
    if not config or not config['emails_enabled']:
        conn.close()
        return

    # Check Gmail credentials
    if not GMAIL_ADDRESS or not GMAIL_APP_PASSWORD:
        conn.close()
        return

    # Get scores and team names
    cursor.execute(f'SELECT q{quarter}_team1, q{quarter}_team2, team1_name, team2_name FROM game_config WHERE id = 1')
    score_config = cursor.fetchone()
    if not score_config or score_config[f'q{quarter}_team1'] is None:
        conn.close()
        return

    team1_score = int(score_config[f'q{quarter}_team1'])
    team2_score = int(score_config[f'q{quarter}_team2'])
    team1_name = score_config['team1_name'] or 'Team 1'
    team2_name = score_config['team2_name'] or 'Team 2'
    is_final = (quarter == 4)

    # Get all active grids
    cursor.execute('SELECT id, name FROM grids WHERE is_active = 1')
    grids = cursor.fetchall()

    winner_emails_set = set()
    sent_count = 0
    failed_count = 0

    # Process each grid — send winner emails
    for grid in grids:
        grid_id = grid['id']
        grid_name = grid['name']

        winner = calculate_quarter_winner(quarter, grid_id, conn)
        if not winner or not winner['owner_email']:
            continue

        # Check if already sent
        cursor.execute(
            'SELECT id FROM email_sends WHERE quarter = ? AND grid_id = ? AND email_type = ? AND recipient_email = ? AND status = ?',
            (quarter, grid_id, 'winner', winner['owner_email'], 'sent')
        )
        if cursor.fetchone():
            winner_emails_set.add(winner['owner_email'])
            continue

        prize_amount = calculate_prize_amount(quarter, conn)

        # Record pending
        now = datetime.now().isoformat()
        cursor.execute(
            'INSERT INTO email_sends (quarter, grid_id, email_type, recipient_email, recipient_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            (quarter, grid_id, 'winner', winner['owner_email'], winner['owner_name'], 'pending', now)
        )
        send_id = cursor.lastrowid
        conn.commit()

        success, error = send_winner_email(
            winner['owner_email'], winner['owner_name'], quarter,
            team1_name, team2_name, team1_score, team2_score,
            prize_amount, grid_name
        )

        if success:
            cursor.execute('UPDATE email_sends SET status = ?, sent_at = ? WHERE id = ?', ('sent', datetime.now().isoformat(), send_id))
            sent_count += 1
        else:
            cursor.execute('UPDATE email_sends SET status = ?, error_message = ? WHERE id = ?', ('failed', error, send_id))
            failed_count += 1
        conn.commit()

        winner_emails_set.add(winner['owner_email'])

    # Collect all unique participant emails (excluding winners)
    cursor.execute('SELECT DISTINCT owner_email, owner_name FROM squares WHERE owner_email IS NOT NULL')
    all_participants = cursor.fetchall()

    for participant in all_participants:
        email = participant['owner_email']
        name = participant['owner_name']

        if email in winner_emails_set:
            continue

        # Check if already sent
        cursor.execute(
            'SELECT id FROM email_sends WHERE quarter = ? AND email_type = ? AND recipient_email = ? AND status = ?',
            (quarter, 'participant', email, 'sent')
        )
        if cursor.fetchone():
            continue

        now = datetime.now().isoformat()
        cursor.execute(
            'INSERT INTO email_sends (quarter, grid_id, email_type, recipient_email, recipient_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            (quarter, None, 'participant', email, name, 'pending', now)
        )
        send_id = cursor.lastrowid
        conn.commit()

        success, error = send_participant_email(
            email, name, quarter, team1_name, team2_name,
            team1_score, team2_score, is_final
        )

        if success:
            cursor.execute('UPDATE email_sends SET status = ?, sent_at = ? WHERE id = ?', ('sent', datetime.now().isoformat(), send_id))
            sent_count += 1
        else:
            cursor.execute('UPDATE email_sends SET status = ?, error_message = ? WHERE id = ?', ('failed', error, send_id))
            failed_count += 1
        conn.commit()

    conn.close()

    # Log audit
    log_audit('emails_sent', f'Q{quarter}: {sent_count} sent, {failed_count} failed')


def send_quarter_emails_async(quarter):
    """Run email sending in a background thread so the sync response isn't delayed"""
    thread = threading.Thread(target=send_quarter_emails, args=(quarter,), daemon=True)
    thread.start()


# Initialize database on module load (works with gunicorn)
init_db()

if __name__ == '__main__':
    app.run(debug=True, port=3000)
