import dropbox, os

access_token = "sl.BvCkQ2jQmpKgYtHUBP8xuIumeGrzxXiNgK3CqUf23ELA20EkEDhr2B1xmclDZ25kWHhwTGEpBcT0Y3XXgsf8TMmofrVD5MQb2YMiSPY0mmBFWSkPbUuEJHnEnZrgNfoxnw-2UkrthIjV3FM"


def upload_file_to_dropbox(local_path):
    dbx = dropbox.Dropbox(access_token)
    dropbox_path = "/AquariumControllerLogs/" + os.path.basename(local_path)
    with open(local_path, 'rb') as f:
        dbx.files_upload(f.read(), dropbox_path, mode=dropbox.files.WriteMode.overwrite)

a = """
/home/adrian/Desktop/Coding/AquariumController/logs/manager/04-02-2024 23-44-11.2024-02-05_05.log.zip
/home/adrian/Desktop/Coding/AquariumController/logs/manager/04-02-2024 23-44-11.2024-02-04_23.log.zip
/home/adrian/Desktop/Coding/AquariumController/logs/manager/04-02-2024 23-44-11.2024-02-05_01.log.zip
/home/adrian/Desktop/Coding/AquariumController/logs/manager/04-02-2024 23-44-11.2024-02-05_03.log.zip
"""

for v in a.strip("\n").split("\n"):
    upload_file_to_dropbox(v)