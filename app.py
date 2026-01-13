from flask import Flask, render_template, request, jsonify, session, redirect
import sqlite3
import json
import random
import hashlib
import os
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

def init_db():
    conn = get_db()
    cursor = conn.cursor()

    # Create squares table with email
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS squares (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            row INTEGER NOT NULL,
            col INTEGER NOT NULL,
            owner_name TEXT,
            owner_email TEXT,
            claimed_at TEXT,
            UNIQUE(row, col)
        )
    ''')

    # Create game_config table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS game_config (
            id INTEGER PRIMARY KEY,
            team1_name TEXT DEFAULT 'Team 1',
            team2_name TEXT DEFAULT 'Team 2',
            row_numbers TEXT,
            col_numbers TEXT,
            numbers_locked INTEGER DEFAULT 0,
            price_per_square REAL DEFAULT 10.00,
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

    # Add email column if not exists (for existing databases)
    try:
        cursor.execute('ALTER TABLE squares ADD COLUMN owner_email TEXT')
    except sqlite3.OperationalError:
        pass

    # Initialize all 100 squares if not exist
    for row in range(10):
        for col in range(10):
            cursor.execute('''
                INSERT OR IGNORE INTO squares (row, col) VALUES (?, ?)
            ''', (row, col))

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
@app.route('/api/grid', methods=['GET'])
def get_grid():
    conn = get_db()
    cursor = conn.cursor()

    # Get all squares (don't expose emails to frontend)
    cursor.execute('SELECT row, col, owner_name, claimed_at FROM squares ORDER BY row, col')
    squares = [dict(row) for row in cursor.fetchall()]

    # Get game config
    cursor.execute('SELECT * FROM game_config WHERE id = 1')
    config_row = cursor.fetchone()
    config = dict(config_row) if config_row else {}

    # Parse JSON arrays for numbers
    if config.get('row_numbers'):
        config['row_numbers'] = json.loads(config['row_numbers'])
    if config.get('col_numbers'):
        config['col_numbers'] = json.loads(config['col_numbers'])

    conn.close()
    return jsonify({
        'squares': squares,
        'config': config,
        'squares_limit': SQUARES_PER_EMAIL_LIMIT
    })

# Claim a square - no login required
@app.route('/api/claim', methods=['POST'])
def claim_square():
    data = request.get_json()
    row = data.get('row')
    col = data.get('col')
    name = data.get('name', '').strip()
    email = data.get('email', '').strip().lower()

    if row is None or col is None:
        return jsonify({'error': 'Row and column required'}), 400

    if not name or not email:
        return jsonify({'error': 'Name and email are required'}), 400

    # Basic email validation
    if '@' not in email or '.' not in email:
        return jsonify({'error': 'Please enter a valid email'}), 400

    conn = get_db()
    cursor = conn.cursor()

    # Check if square is already claimed
    cursor.execute('SELECT owner_name FROM squares WHERE row = ? AND col = ?', (row, col))
    result = cursor.fetchone()

    if result and result['owner_name']:
        conn.close()
        return jsonify({'error': 'This square is already taken'}), 400

    # Check email's square limit
    cursor.execute('SELECT COUNT(*) FROM squares WHERE owner_email = ?', (email,))
    email_square_count = cursor.fetchone()[0]
    if email_square_count >= SQUARES_PER_EMAIL_LIMIT:
        conn.close()
        return jsonify({'error': f'This email has already claimed {SQUARES_PER_EMAIL_LIMIT} squares (the maximum allowed)'}), 400

    # Claim the square
    cursor.execute('''
        UPDATE squares SET owner_name = ?, owner_email = ?, claimed_at = ? WHERE row = ? AND col = ?
    ''', (name, email, datetime.now().isoformat(), row, col))

    conn.commit()
    conn.close()
    return jsonify({'success': True})

# Admin: Clear a square
@app.route('/api/admin/clear-square', methods=['POST'])
@admin_required
def clear_square():
    data = request.get_json()
    row = data.get('row')
    col = data.get('col')

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('''
        UPDATE squares SET owner_name = NULL, owner_email = NULL, claimed_at = NULL WHERE row = ? AND col = ?
    ''', (row, col))
    conn.commit()
    conn.close()
    return jsonify({'success': True})

@app.route('/api/randomize', methods=['POST'])
@admin_required
def randomize_numbers():
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('SELECT numbers_locked FROM game_config WHERE id = 1')
    result = cursor.fetchone()
    if result and result['numbers_locked']:
        conn.close()
        return jsonify({'error': 'Numbers are locked'}), 400

    row_numbers = list(range(10))
    col_numbers = list(range(10))
    random.shuffle(row_numbers)
    random.shuffle(col_numbers)

    cursor.execute('''
        UPDATE game_config SET row_numbers = ?, col_numbers = ? WHERE id = 1
    ''', (json.dumps(row_numbers), json.dumps(col_numbers)))

    conn.commit()
    conn.close()
    return jsonify({'row_numbers': row_numbers, 'col_numbers': col_numbers})

@app.route('/api/lock-numbers', methods=['POST'])
@admin_required
def lock_numbers():
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('UPDATE game_config SET numbers_locked = 1 WHERE id = 1')
    conn.commit()
    conn.close()
    return jsonify({'success': True})

@app.route('/api/config', methods=['POST'])
@admin_required
def update_config():
    data = request.get_json()
    conn = get_db()
    cursor = conn.cursor()

    if 'team1_name' in data:
        cursor.execute('UPDATE game_config SET team1_name = ? WHERE id = 1', (data['team1_name'],))
    if 'team2_name' in data:
        cursor.execute('UPDATE game_config SET team2_name = ? WHERE id = 1', (data['team2_name'],))
    if 'price_per_square' in data:
        cursor.execute('UPDATE game_config SET price_per_square = ? WHERE id = 1', (data['price_per_square'],))

    conn.commit()
    conn.close()
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

@app.route('/api/reset', methods=['POST'])
@admin_required
def reset_game():
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('UPDATE squares SET owner_name = NULL, owner_email = NULL, claimed_at = NULL')
    cursor.execute('''
        UPDATE game_config SET
            row_numbers = NULL, col_numbers = NULL, numbers_locked = 0,
            q1_team1 = NULL, q1_team2 = NULL,
            q2_team1 = NULL, q2_team2 = NULL,
            q3_team1 = NULL, q3_team2 = NULL,
            q4_team1 = NULL, q4_team2 = NULL
        WHERE id = 1
    ''')

    conn.commit()
    conn.close()
    return jsonify({'success': True})

if __name__ == '__main__':
    init_db()
    app.run(debug=True, port=3000)
