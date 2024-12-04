import * as Yup from 'yup';
import { Form, Formik } from 'formik';
import React, {
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState
} from 'react';
import { Button } from './ui/button';
import { DateField } from '../components/formfields/DateField';
import moment from 'moment';
import ResponsiveDialog from '../components/ResponsiveDialog';
import { SelectField } from '../components/formfields/SelectField';
import { StoreContext } from '../store';
import { toast } from 'sonner';
import { toJS } from 'mobx';
import { uploadDocument } from '../utils/fetch';
import { UploadField } from '@microrealestate/commonui/components';
import useTranslation from 'next-translate/useTranslation';

const UPLOAD_MAX_SIZE = 2_000_000_000; // 2Gb
const SUPPORTED_MIMETYPES = [
  'image/gif',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/jpe',
  'application/pdf'
];
const validationSchema = Yup.object().shape({
  template: Yup.object().required(),
  description: Yup.string(),
  file: Yup.mixed()
    .nullable()
    .required()
    .test(
      'UPLOAD_MAX_SIZE',
      'File is too big. Maximum size is 2Go.',
      (value) => value && value.size <= UPLOAD_MAX_SIZE
    )
    .test(
      'FILE_FORMAT',
      'File is not allowed. Only images or pdf are accepted.',
      (value) => value && SUPPORTED_MIMETYPES.includes(value.type)
    ),
  expiryDate: Yup.mixed()
    .when('template', (template, schema) => {
      return template?.hasExpiryDate ? schema.required() : schema;
    })
    .test('expiryDate', 'Date is invalid', (value) => {
      if (value) {
        return moment(value).isValid();
      }
      return true;
    })
});

const defaultValues = {
  template: '',
  description: '',
  file: '',
  expiryDate: null
};

export default function UploadDialog({
  open,
  setOpen,
  data: selectedTemplate,
  onSave
}) {
  const { t } = useTranslation('common');
  const store = useContext(StoreContext);
  const [isLoading, setIsLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const formRef = useRef();

  const templates = useMemo(() => {
    return store.template.items
      .filter(
        (template) =>
          template.type === 'fileDescriptor' &&
          template.linkedResourceIds?.includes(store.tenant.selected?.leaseId)
      )
      .map((template) => ({
        id: template._id,
        label: template.name,
        description: template.description,
        value: toJS(template)
      }));
  }, [store.template.items, store.tenant.selected]);

  const initialValues = {
    ...defaultValues,
    template: selectedTemplate || ''
  };

  const handleClose = useCallback(() => {
    setOpen(false);
  }, [setOpen]);

  const _onSubmit = useCallback(
    async (doc, { resetForm }) => {
      try {
        setIsLoading(true);
        setUploadProgress(0);
        doc.name = doc.template.name;
        doc.description = doc.template.description;
        doc.mimeType = doc.file.type;
        try {
          const xhr = new XMLHttpRequest();
          
          // Track upload progress
          xhr.upload.addEventListener('progress', (event) => {
            if (event.lengthComputable) {
              const progress = (event.loaded / event.total) * 100;
              setUploadProgress(progress);
            }
          });

          // Create FormData
          const formData = new FormData();
          formData.append('file', doc.file);
          formData.append('documentName', doc.template.name);
          formData.append('folder', [
            store.tenant.selected.name.replace(/[/\\]/g, '_'),
            'contract_scanned_documents'
          ].join('/'));

          // Create a promise that wraps XMLHttpRequest
          const uploadPromise = new Promise((resolve, reject) => {
            xhr.onload = () => {
              if (xhr.status >= 200 && xhr.status < 300) {
                try {
                  resolve(JSON.parse(xhr.responseText));
                } catch (e) {
                  reject(new Error('Invalid response from server'));
                }
              } else {
                reject(new Error('Upload failed'));
              }
            };
            xhr.onerror = () => reject(new Error('Network error'));
            xhr.open('POST', '/documents/upload');
            xhr.send(formData);
          });

          const response = await uploadPromise;
          doc.url = response.data.key;
          doc.versionId = response.data.versionId;
        } catch (error) {
          console.error(error);
          toast.error(t('Cannot upload document'));
          return;
        }
        handleClose();
        try {
          await onSave(doc);
          resetForm();
        } catch (error) {
          console.error(error);
          toast.error(t('Cannot save document'));
        }
      } finally {
        setIsLoading(false);
      }
    },
    [handleClose, t, onSave, store]
  );

  return (
    <ResponsiveDialog
      open={open}
      setOpen={setOpen}
      isLoading={isLoading}
      renderHeader={() => t('Document to upload')}
      renderContent={() => (
        <Formik
          initialValues={initialValues}
          validationSchema={validationSchema}
          onSubmit={_onSubmit}
          innerRef={formRef}
        >
          {({ values }) => {
            return (
              <Form autoComplete="off">
                {selectedTemplate ? (
                  selectedTemplate.name
                ) : (
                  <SelectField
                    label={t('Document')}
                    name="template"
                    values={templates}
                  />
                )}
                {values.template?.hasExpiryDate && (
                  <DateField label={t('Expiry date')} name="expiryDate" />
                )}
                <UploadField name="file" />
                {isLoading && uploadProgress > 0 && (
                  <div className="space-y-2 mt-4">
                    <div className="w-full bg-gray-200 rounded-full h-2.5">
                      <div
                        className="bg-blue-600 h-2.5 rounded-full transition-all duration-300"
                        style={{ width: `${uploadProgress}%` }}
                      ></div>
                    </div>
                    <p className="text-sm text-center text-gray-600">
                      {t('Uploading... {{progress}}%', { progress: Math.round(uploadProgress) })}
                    </p>
                  </div>
                )}
              </Form>
            );
          }}
        </Formik>
      )}
      renderFooter={() => (
        <>
          <Button
            variant="outline"
            onClick={() => {
              formRef.current.resetForm();
              handleClose();
            }}
          >
            {t('Cancel')}
          </Button>
          <Button onClick={() => formRef.current.submitForm()}>
            {t('Upload')}
          </Button>
        </>
      )}
    />
  );
}
