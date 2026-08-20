from app.db.session import SessionLocal
from app.services.collections import seed_collections
db = SessionLocal()
seed_collections(db)
db.close()
print("Done")
