# HypeUp – Smart Campus Event & Role-Based Engagement Platform

Express + SQLite full-stack web application with **3-Role Access Control** (**Student**, **Faculty**, **Admin**), persistent relational storage, event approval workflow, QR ticket generation, camera/manual check-in, and live audit logging.

## Run it
1. Install Node.js 20 or newer.
2. In this folder run: `npm install` then `npm start`
3. Public & Student Discovery: http://localhost:3002
4. Role-Based Login Portal: http://localhost:3002/login.html
   - **Student**: `student@hypeup.edu` / `student123` (or sign up a new student account)
   - **Faculty**: `faculty@hypeup.edu` / `faculty123`
   - **Admin**: Configured via `ADMIN_EMAIL` / `ADMIN_PASS` (or default admin account)

## Where is the student & event data saved?
All data is persisted locally in the relational SQLite database file `hypeup.db` (WAL mode, foreign keys enabled) across 5 normalized tables:
1. `users` — Student, Faculty, and Admin accounts (with USN/ID, department, scrypt password hashes).
2. `events` — Event metadata, capacity, status (`pending`, `approved`, `rejected`), creator ID, and approver ID.
3. `registrations` — Student event registrations, unique `HU-XXXXXX` ticket IDs, USN, department, and check-in timestamps.
4. `announcements` — Campus-wide notices posted by Faculty or Admin.
5. `audit_logs` — Complete history of who created, updated, approved, deleted, registered, or checked in.

## Who updates the events?
- **Faculty Coordinators** log in to `faculty.html` to propose/create department events (queued as `pending`), edit their own events, view/export registrations, post announcements, and check students in.
- **Admins** log in to `admin.html` to approve/reject faculty-proposed events, create/edit/delete any event, manage user accounts, inspect database storage, and monitor the live audit trail.
- **Students** log in to `student.html` (or browse `index.html`) to filter/search approved events, register with 1 click, view/print QR tickets, or cancel un-checked-in registrations.
