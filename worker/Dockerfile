FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# Install from the fully-resolved lockfile, not the direct-dependency list.
# Pinning only direct deps let supabase's transitive packages drift to an
# incompatible pair on a fresh install, which crashed the container at import
# with "No module named 'supabase_auth.http_clients'".
COPY requirements.lock.txt .
RUN pip install --no-cache-dir -r requirements.lock.txt

COPY . .

# Fail fast and loudly if the dependency tree is ever broken again, rather
# than discovering it from a restart loop in production.
RUN python -c "import yfinance, pandas; from supabase import create_client; print('deps ok')"

CMD ["python", "poller.py"]
