import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectTaggingCommand,
  GetObjectTaggingCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { calculateVariablePartSize } from "@util/helpers/s3-helpers";
import { DriveFile, DriveFolder, Provider, Tag, StorageDrive, UploadingFile } from "@util/types";
import { Upload } from "@util/upload";
import mime from "mime-types";
import { nanoid } from "nanoid";
import { createContext, PropsWithChildren, useContext, useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { ContextValue, ROOT_FOLDER } from "./useBucket";
import useUser from "./useUser";

const S3Context = createContext<ContextValue>(null);
export default () => useContext(S3Context);

type Props = {
  data: StorageDrive;
  fullPath?: string;
};

export const S3Provider: React.FC<PropsWithChildren<Props>> = ({ data, fullPath, children }) => {
  if (data.permissions !== "owned" || data.type === "firebase") {
    toast.error("Drive type invalid for S3 Provider.");
    return;
  }

  const [s3Client, setS3Client] = useState<S3Client>(
    new S3Client({
      region: data.keys.region,
      maxAttempts: 1,
      credentials: {
        accessKeyId: data.keys.accessKey,
        secretAccessKey: data.keys.secretKey,
      },
      ...(data.keys?.endpoint ? { endpoint: data.keys.endpoint } : {}),
    }),
  );
  const [loading, setLoading] = useState(false);
  const { user } = useUser();

  const [currentFolder, setCurrentFolder] = useState<DriveFolder>(null);
  const [folders, setFolders] = useState<DriveFolder[]>(null);
  const [uploadingFiles, setUploadingFiles] = useState<UploadingFile[]>([]);
  const [files, setFiles] = useState<DriveFile[]>(null);
  const isMounted = useRef(false);
  // enable tags if s3. add new providers with tag support here
  const enableTags = (Provider[data.type] as Provider) === Provider.s3;

  // Fallback for old buckets not already having the bucketUrl.
  useEffect(() => {
    if (isMounted.current || !data?.keys) return;
    isMounted.current = true;
    if (data.keys.bucketUrl) return;

    switch (Provider[data.type] as Provider) {
      case Provider.s3:
        data.keys.bucketUrl = `https://${data.keys.Bucket}.s3.${data.keys.region}.amazonaws.com`;
        break;
      case Provider.backblaze:
        data.keys.bucketUrl = `https://${data.keys.Bucket}.s3.${data.keys.region}.backblazeb2.com`;
        break;
      default:
        break;
    }

    return () => {
      isMounted.current = false;
    };
  }, [data]);

  const addFolder = (name: string) => {
    const path =
      currentFolder.fullPath !== ""
        ? decodeURIComponent(currentFolder.fullPath) + name + "/"
        : name + "/";

    const newFolder: DriveFolder = {
      name,
      fullPath: path,
      parent: currentFolder.fullPath,
      createdAt: new Date().toISOString(),
      bucketName: data.keys.Bucket,
      bucketUrl: data.keys.bucketUrl,
    };

    setFolders((folders) => [...folders, newFolder]);
    const localFolders = localStorage.getItem(`local_folders_${data.id}`);
    const folders: DriveFolder[] = localFolders ? JSON.parse(localFolders) : [];
    localStorage.setItem(`local_folders_${data.id}`, JSON.stringify([...folders, newFolder]));
  };

  const removeFolder = async (folder: DriveFolder) => {
    // remove from local state
    setFolders((folders) => folders.filter((f) => f.fullPath !== folder.fullPath));

    // delete from localStorage
    const localFolders = localStorage.getItem(`local_folders_${data.id}`);
    if (localFolders) {
      const folders = JSON.parse(localFolders);
      const filtered = folders.filter((f) => !f.fullPath.includes(folder.fullPath));
      localStorage.setItem(`local_folders_${data.id}`, JSON.stringify(filtered));
    }

    // recursively delete children
    await emptyS3Directory(s3Client, folder.bucketName, folder.fullPath);
  };

  const addFile = async (filesToUpload: File[] | FileList) => {
    Array.from(filesToUpload).forEach(async (file) => {
      if (/[#\$\[\]\*/]/.test(file.name))
        return toast.error("File name cannot contain special characters (#$[]*/).");

      if (files?.filter((f) => f.name === file.name).length > 0)
        return toast.error("File with same name already exists.");

      const id = nanoid();
      const Key =
        currentFolder === ROOT_FOLDER
          ? file.name
          : `${decodeURIComponent(currentFolder.fullPath)}${file.name}`;

      const upload = new Upload({
        client: s3Client,
        params: {
          Key,
          Body: file,
          Bucket: data.keys.Bucket,
          ContentType: mime.lookup(file.name) || "application/octet-stream",
        },
        partSize: calculateVariablePartSize(file.size),
      });

      upload.on("initiated", () => {
        setUploadingFiles((prev) =>
          prev.concat([
            {
              id,
              name: file.name,
              key: Key,
              task: upload,
              state: "running",
              progress: 0,
              error: false,
            },
          ]),
        );
      });

      upload.on("progress", (progress) => {
        setUploadingFiles((prevUploadingFiles) =>
          prevUploadingFiles.map((uploadFile) => {
            return uploadFile.id === id
              ? {
                  ...uploadFile,
                  state: "running",
                  progress: Number(
                    parseFloat(((progress.loaded / progress.total) * 100).toString()).toFixed(2),
                  ),
                }
              : uploadFile;
          }),
        );
      });

      upload.on("paused", () => {
        setUploadingFiles((prevUploadingFiles) =>
          prevUploadingFiles.map((uploadFile) => {
            return uploadFile.id === id ? { ...uploadFile, state: "paused" } : uploadFile;
          }),
        );
      });

      upload.on("resumed", () => {
        setUploadingFiles((prevUploadingFiles) =>
          prevUploadingFiles.map((uploadFile) => {
            return uploadFile.id === id ? { ...uploadFile, state: "running" } : uploadFile;
          }),
        );
      });

      upload.on("error", (err) => {
        toast.error(err.message);
        setUploadingFiles((prevUploadingFiles) => {
          return prevUploadingFiles.map((uploadFile) => {
            if (uploadFile.id === id) return { ...uploadFile, error: true };
            return uploadFile;
          });
        });
      });

      upload.on("completed", async () => {
        setUploadingFiles((prevUploadingFiles) =>
          prevUploadingFiles.filter((uploadFile) => uploadFile.id !== id),
        );
        const newFile: DriveFile = {
          fullPath: Key,
          name: file.name,
          parent: currentFolder.fullPath,
          size: file.size.toString(),
          createdAt: new Date().toISOString(),
          contentType: mime.lookup(file.name) || "application/octet-stream",
          bucketName: data.keys.Bucket,
          bucketUrl: `https://${data.keys.Bucket}.s3.${data.keys.region}.amazonaws.com`,
          url: await getSignedUrl(
            s3Client,
            new GetObjectCommand({ Bucket: data.keys.Bucket, Key: Key }),
            { expiresIn: 3600 * 24 },
          ),
        };

        setFiles((files) => (files ? [...files, newFile] : [newFile]));
        toast.success("File uploaded successfully.");
      });

      await upload.start();
    });
  };

  const removeFile = async (file: DriveFile) => {
    setFiles((files) => files.filter((f) => f.fullPath !== file.fullPath));
    await s3Client.send(new DeleteObjectCommand({ Bucket: data.keys.Bucket, Key: file.fullPath }));
    return true;
  };

  // To be implemented
  const syncFilesInCurrentFolder = async () => {
    return () => {};
  };

  // get array of tags
  const listTags = async (file: DriveFile): Promise<Tag[] | void> => {
    try {
      if (!enableTags) return;
      const response = await s3Client.send(
        new GetObjectTaggingCommand({ Bucket: data.keys.Bucket, Key: file.fullPath }),
      );
      return response.TagSet.map((tag) => ({ key: tag.Key, value: tag.Value }));
    } catch (err) {
      toast.error(`Error: ${err.message}`);
    }
  };

  // add tag to existing object
  const addTags = async (file: DriveFile, key: string, value: string): Promise<boolean> => {
    if (!key.trim()) {
      toast.error("Error: Tag key is blank.");
      return false;
    }
    key = key.trim();
    const currentTagsResponse = await s3Client.send(
      new GetObjectTaggingCommand({
        Bucket: data.keys.Bucket,
        Key: file.fullPath,
      }),
    );
    const currentTags = currentTagsResponse.TagSet;
    currentTags.push({ Key: key, Value: value });
    const params = {
      Bucket: data.keys.Bucket,
      Key: file.fullPath,
      Tagging: { TagSet: currentTags },
    };

    try {
      await s3Client.send(new PutObjectTaggingCommand(params));
      return true;
    } catch (err) {
      toast.error(`Error: ${err.message}`);
      return false;
    }
  };

  // edit existing tag
  const editTags = async (file: DriveFile, prevTag: Tag, newTag: Tag): Promise<boolean> => {
    // remove previous tag in order to edit
    if (!(await removeTags(file, prevTag.key))) {
      return false;
    } else {
      // add the new tag
      if (await addTags(file, newTag.key, newTag.value)) {
        return true;
      } else {
        // if new tag values are invalid, add back the previous tag
        await addTags(file, prevTag.key, prevTag.value);
        toast.error(`Error: Tag not edited.`);
        return false;
      }
    }
  };

  // remove tag from an object
  const removeTags = async (file: DriveFile, key: string): Promise<boolean> => {
    const getTagging = await s3Client.send(
      new GetObjectTaggingCommand({ Bucket: data.keys.Bucket, Key: file.fullPath }),
    );
    let existingTags = getTagging.TagSet;
    const updatedTags = existingTags.filter((tag) => tag.Key !== key);

    const putTagging = {
      Bucket: data.keys.Bucket,
      Key: file.fullPath,
      Tagging: { TagSet: updatedTags },
    };

    try {
      await s3Client.send(new PutObjectTaggingCommand(putTagging));
      return true;
    } catch (err) {
      toast.error(`Error: ${err.message}`);
      return false;
    }
  };

  // set currentFolder
  useEffect(() => {
    if (!user?.email) return;
    setFiles(null);
    setFolders(null);

    if (fullPath === "" || !fullPath) {
      setCurrentFolder(ROOT_FOLDER);
      return;
    }

    setCurrentFolder({
      fullPath: fullPath + "/",
      name: fullPath.split("/").pop(),
      bucketName: data.keys.Bucket,
      parent: fullPath.split("/").shift() + "/",
      bucketUrl: data.keys.bucketUrl,
    });
  }, [fullPath, user]);

  // get files and folders
  useEffect(() => {
    if (!user?.email || !currentFolder) return;
    setLoading(true);

    (async () => {
      try {
        if (!files) {
          let results = await s3Client.send(
            new ListObjectsV2Command({
              Bucket: data.keys.Bucket,
              Prefix: currentFolder.fullPath,
              Delimiter: "/",
            }),
          );

          if (results.Contents) {
            results.Contents.forEach(async (result) => {
              const driveFile: DriveFile = {
                fullPath: result.Key,
                name: result.Key.split("/").pop(),
                parent: currentFolder.fullPath,
                createdAt: result.LastModified.toISOString(),
                size: result.Size.toString(),
                contentType: mime.lookup(result.Key) || "",
                bucketName: results.Name,
                bucketUrl: data.keys.bucketUrl,
                url: await getSignedUrl(
                  s3Client,
                  new GetObjectCommand({
                    Bucket: results.Name,
                    Key: result.Key,
                  }),
                  { expiresIn: 3600 * 24 },
                ),
              };

              setFiles((files) => (files ? [...files, driveFile] : [driveFile]));
            });
          }

          const localFolders = localStorage.getItem(`local_folders_${data.id}`);
          let localFoldersArray: DriveFolder[] = localFolders ? JSON.parse(localFolders) : [];
          localFoldersArray = localFoldersArray.filter(
            (folder) =>
              folder.parent === currentFolder.fullPath &&
              !results.CommonPrefixes?.find((prefix) => prefix.Prefix === folder.fullPath),
          );

          setFolders(localFoldersArray);

          if (results.CommonPrefixes) {
            for (let i = 0; i < results.CommonPrefixes.length; i++) {
              const driveFolder: DriveFolder = {
                fullPath: results.CommonPrefixes[i].Prefix,
                name: results.CommonPrefixes[i].Prefix.slice(0, -1).split("/").pop(),
                bucketName: results.Name,
                parent: currentFolder.fullPath,
                bucketUrl: data.keys.bucketUrl,
              };
              setFolders((folders) => [...folders, driveFolder]);
            }
          }

          // loop to list all files.
          while (results.IsTruncated) {
            results = await s3Client.send(
              new ListObjectsV2Command({
                Bucket: data.keys.Bucket,
                Prefix: currentFolder.fullPath,
                ContinuationToken: results.ContinuationToken,
                Delimiter: "/",
              }),
            );

            results.Contents.forEach(async (result) => {
              const driveFile: DriveFile = {
                fullPath: result.Key,
                name: result.Key.split("/").pop(),
                parent: currentFolder.fullPath,
                createdAt: result.LastModified.toISOString(),
                size: result.Size.toString(),
                contentType: mime.lookup(result.Key) || "",
                bucketName: results.Name,
                bucketUrl: data.keys.bucketUrl,
                url: await getSignedUrl(
                  s3Client,
                  new GetObjectCommand({
                    Bucket: results.Name,
                    Key: result.Key,
                  }),
                  { expiresIn: 3600 * 24 },
                ),
              };
              setFiles((files) => (files ? [...files, driveFile] : [driveFile]));
            });
          }
        }
      } catch (err) {
        console.error(err);
      }

      setLoading(false);
    })();
  }, [currentFolder, user]);

  return (
    <S3Context.Provider
      value={{
        loading,
        currentFolder,
        files,
        folders,
        uploadingFiles,
        setUploadingFiles,
        addFile,
        addFolder,
        removeFile,
        removeFolder,
        syncFilesInCurrentFolder,
        enableTags,
        listTags,
        addTags,
        editTags,
        removeTags,
      }}
    >
      {children}
    </S3Context.Provider>
  );
};

async function emptyS3Directory(client: S3Client, Bucket: string, Prefix: string) {
  const listParams = { Bucket, Prefix };
  const listedObjects = await client.send(new ListObjectsV2Command(listParams));

  if (listedObjects.CommonPrefixes?.length > 0) {
    for (let i = 0; i < listedObjects.CommonPrefixes.length; i++) {
      await emptyS3Directory(client, Bucket, listedObjects.CommonPrefixes[i].Prefix);
    }
  }

  if (listedObjects.Contents?.length === 0) return;

  const deleteParams = { Bucket, Delete: { Objects: [] } };

  for (let i = 0; i < listedObjects.Contents.length; i++) {
    deleteParams.Delete.Objects.push({ Key: listedObjects.Contents[i].Key });
  }

  await client.send(new DeleteObjectsCommand(deleteParams));
  if (listedObjects.IsTruncated) await emptyS3Directory(client, Bucket, Prefix);
}
