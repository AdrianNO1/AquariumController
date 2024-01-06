from datetime import datetime

now = datetime.now()
minutes_of_day = int((now - now.replace(hour=0, minute=0, second=0, microsecond=0)).total_seconds()/60)

print(minutes_of_day)